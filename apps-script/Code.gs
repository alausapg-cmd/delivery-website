/**
 * Dispatch Desk: Google Apps Script server for the delivery website.
 *
 * The website (index.html on Vercel) calls doPost() below. Everything is saved in a
 * Google Sheet called "Dispatch Desk data" in your Drive, created on first use.
 *
 *   Customers   <site>                 book a delivery, track a package
 *   Vendors     <site>?merchant=1      vendor accounts, bulk orders, pickups, reports
 *   Riders      <site>?rider=1         rider run sheet and proof of delivery
 *   Staff       <site>?staff=1         dispatch board (needs STAFF_PIN)
 */

// CHANGE THIS before you deploy. Staff type it to open the dispatch board.
var STAFF_PIN = '2468';

// Optional: your website address, e.g. 'https://yourcompany.vercel.app'. Opening the
// Apps Script link then sends people to the website.
var SITE_URL = '';

var COLS = ['orders', 'riders', 'settings', 'zones', 'merchants', 'pickups'];
var HEADERS = {
  orders: ['Code', 'Status', 'Booked at', 'Vendor', 'Sender', 'Sender phone', 'Pickup address', 'Receiver', 'Receiver phone',
           'Delivery address', 'Area', 'Zone', 'Item', 'Fee (₦)', 'Fee paid by', 'Collect (₦)', 'Rider', 'Received by',
           'Last update', 'data'],
  riders: ['ID', 'Name', 'Phone', 'Plate', 'Zones', 'Off duty', 'Last location', 'Location time', 'data'],
  settings: ['Key', 'Value', 'data'],
  zones: ['ID', 'Zone', 'Areas', 'Fee (₦)', 'data'],
  merchants: ['ID', 'Business', 'Contact', 'Phone', 'Email', 'Address', 'Joined', 'Active', 'data'],
  pickups: ['ID', 'Vendor', 'Phone', 'Address', 'Date', 'Time', 'Packages', 'Status', 'Rider', 'Last update', 'data']
};
var MAX_BULK = 500;

/* ================= Web entry points ================= */

function doGet() {
  if (SITE_URL) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif">Opening the website… <a href="' + SITE_URL +
      '" target="_top">Continue</a></p><script>window.top.location.href=' + JSON.stringify(SITE_URL) + '</script>');
  }
  return HtmlService.createHtmlOutput('<p style="font:16px sans-serif">This is the server for your delivery website. ' +
    'It is working. Open your website address to use it.</p>');
}

var API = {
  publicInfo: publicInfo, bookOrder: bookOrder, trackOrder: trackOrder,
  merchantSignup: merchantSignup, merchantLogin: merchantLogin, merchantData: merchantData,
  merchantCreateOrders: merchantCreateOrders, merchantSchedulePickup: merchantSchedulePickup,
  merchantCancelOrder: merchantCancelOrder,
  riderLogin: riderLogin, riderData: riderData, riderAction: riderAction, riderLocation: riderLocation,
  staffLogin: staffLogin, staffGetAll: staffGetAll, staffSet: staffSet, staffSetMany: staffSetMany,
  staffDelete: staffDelete, staffAutoAssign: staffAutoAssign, staffPod: staffPod, staffSetRiderPin: staffSetRiderPin,
  staffAssignPickup: staffAssignPickup, staffCollectPickup: staffCollectPickup
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API.hasOwnProperty(req.fn) ? API[req.fn] : null;
    if (!fn) throw new Error('Unknown request. If you just updated the website, publish the Apps Script as a new version.');
    out = { ok: true, result: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= Customers ================= */

function publicInfo() {
  var s = readCol_('settings');
  return { company: (s.company && s.company.name) || '', zones: zoneList_() };
}

function bookOrder(f) {
  f = f || {};
  requireFields_(f, ['senderName', 'senderPhone', 'receiverName', 'receiverPhone', 'receiverAddress', 'area', 'item']);
  if (f.arrive === 'pickup' && !clean_(f.senderAddress, 300)) throw new Error('Please add your pickup address.');
  throttle_('book:' + clean_(f.senderPhone, 40), 10);
  return withLock_(function () {
    var orders = readCol_('orders'), zones = readCol_('zones');
    var o = newOrder_(orders, zones, {
      source: 'customer',
      sender: { name: f.senderName, phone: f.senderPhone,
                address: f.arrive === 'pickup' ? f.senderAddress : '(Customer will drop off at office)' },
      receiver: { name: f.receiverName, phone: f.receiverPhone, address: f.receiverAddress, area: f.area },
      item: f.item, size: f.size, feeBy: f.feeBy, collect: f.collect, due: f.due, notes: f.notes
    }, 'Booked online by customer');
    writeMany_('orders', single_(o.code, o));
    return { code: o.code, fee: o.fee };
  });
}

function trackOrder(code) {
  code = normCode_(code);
  throttle_('track', 400);
  var o = readCol_('orders')[code];
  if (!o) return null;
  var r = o.riderId ? readCol_('riders')[o.riderId] : null;
  var showRider = r && (o.status === 'out' || o.status === 'pickup');
  return {
    code: o.code, status: o.status, item: o.item, fee: o.fee, feeBy: o.feeBy, vendor: o.merchantName || '',
    receiver: { name: firstName_(o.receiver && o.receiver.name), area: o.receiver && o.receiver.area },
    rider: showRider ? { name: r.name, phone: r.phone } : null,
    pod: o.pod ? { receivedBy: o.pod.receivedBy, at: o.pod.at } : null,
    history: (o.history || []).map(function (h) { return { status: h.status, at: h.at }; })
  };
}

/* ================= Vendors (merchant accounts) ================= */

function merchantSignup(f) {
  f = f || {};
  requireFields_(f, ['business', 'contact', 'phone', 'address', 'area', 'password']);
  if (String(f.password).length < 6) throw new Error('Choose a password of at least 6 characters.');
  throttle_('signup', 30);
  return withLock_(function () {
    var ms = readCol_('merchants'), phone = normPhone_(f.phone);
    for (var id in ms) if (normPhone_(ms[id].phone) === phone) throw new Error('A vendor account already uses this phone number. Sign in instead.');
    var salt = Utilities.getUuid(), mid = 'm' + Date.now().toString(36);
    var m = { business: clean_(f.business, 120), contact: clean_(f.contact, 120), phone: clean_(f.phone, 40),
              email: clean_(f.email, 120), address: clean_(f.address, 300), area: clean_(f.area, 80),
              active: true, createdAt: now_(), salt: salt, pwHash: hash_(salt, f.password) };
    writeMany_('merchants', single_(mid, m));
    return { token: makeToken_('m', mid), merchant: publicMerchant_(mid, m) };
  });
}

function merchantLogin(phone, password) {
  var key = 'mlogin:' + normPhone_(phone);
  guardFails_(key);
  var ms = readCol_('merchants');
  for (var id in ms) {
    var m = ms[id];
    if (normPhone_(m.phone) === normPhone_(phone) && m.pwHash === hash_(m.salt, password)) {
      if (m.active === false) throw new Error('This vendor account is paused. Please contact us.');
      return { token: makeToken_('m', id), merchant: publicMerchant_(id, m) };
    }
  }
  noteFail_(key);
  throw new Error('Wrong phone number or password.');
}

function merchantData(token) {
  var mid = checkToken_(token, 'm'), m = readCol_('merchants')[mid];
  if (!m || m.active === false) throw new Error('Please sign in again.');
  var orders = readCol_('orders'), pickups = readCol_('pickups'), riders = readCol_('riders');
  var myOrders = [], myPickups = [];
  for (var c in orders) if (orders[c].merchantId === mid) myOrders.push(merchantView_(orders[c], riders));
  for (var p in pickups) if (pickups[p].merchantId === mid) {
    var pk = pickups[p], r = pk.riderId && riders[pk.riderId];
    myPickups.push({ id: p, date: pk.date, window: pk.window, address: pk.address, count: pk.count, codes: pk.codes,
                     status: pk.status, notes: pk.notes, rider: r ? { name: r.name, phone: r.phone } : null, createdAt: pk.createdAt });
  }
  return { merchant: publicMerchant_(mid, m), orders: myOrders, pickups: myPickups, zones: zoneList_(),
           company: (readCol_('settings').company || {}).name || '' };
}

function merchantCreateOrders(token, rows, pickupReq) {
  var mid = checkToken_(token, 'm');
  if (!Array.isArray(rows) || !rows.length) throw new Error('There are no orders to create.');
  if (rows.length > MAX_BULK) throw new Error('Upload at most ' + MAX_BULK + ' orders at a time.');
  return withLock_(function () {
    var m = readCol_('merchants')[mid];
    if (!m || m.active === false) throw new Error('Please sign in again.');
    var orders = readCol_('orders'), zones = readCol_('zones'), docs = {}, created = [], errors = [];
    rows.forEach(function (r, i) {
      try {
        requireFields_(r, ['receiverName', 'receiverPhone', 'receiverAddress', 'area', 'item']);
        var o = newOrder_(orders, zones, {
          source: 'merchant', merchantId: mid, merchantName: m.business, ref: clean_(r.ref, 60),
          sender: { name: m.business, phone: m.phone, address: m.address },
          receiver: { name: r.receiverName, phone: r.receiverPhone, address: r.receiverAddress, area: r.area },
          item: r.item, size: r.size, feeBy: r.feeBy, collect: r.collect, due: r.due, notes: r.notes
        }, rows.length > 1 ? 'Uploaded by vendor (bulk)' : 'Booked by vendor');
        orders[o.code] = o; docs[o.code] = o;
        created.push({ row: r.row || i + 1, code: o.code, ref: o.ref, receiver: o.receiver.name, fee: o.fee });
      } catch (err) {
        errors.push({ row: r.row || i + 1, error: String(err.message || err) });
      }
    });
    if (created.length) writeMany_('orders', docs);
    var pickup = null;
    if (pickupReq && created.length) {
      pickup = schedulePickup_(mid, m, pickupReq, created.map(function (c) { return c.code; }), orders);
    }
    return { created: created, errors: errors, pickup: pickup };
  });
}

function merchantSchedulePickup(token, req) {
  var mid = checkToken_(token, 'm');
  return withLock_(function () {
    var m = readCol_('merchants')[mid];
    if (!m || m.active === false) throw new Error('Please sign in again.');
    return schedulePickup_(mid, m, req || {}, (req && req.codes) || [], readCol_('orders'));
  });
}

function merchantCancelOrder(token, code) {
  var mid = checkToken_(token, 'm');
  return withLock_(function () {
    var o = readCol_('orders')[normCode_(code)];
    if (!o || o.merchantId !== mid) throw new Error('Order not found.');
    if (o.status !== 'booked') throw new Error('This order has already been picked up, so it can no longer be cancelled here. Please call us.');
    addHistory_(o, 'cancelled', 'Cancelled by vendor');
    writeMany_('orders', single_(o.code, o));
    return true;
  });
}

function schedulePickup_(mid, m, req, codes, orders) {
  if (!req.date) throw new Error('Choose a pickup date.');
  var mine = codes.filter(function (c) { var o = orders[c]; return o && o.merchantId === mid && o.status === 'booked'; });
  var zones = readCol_('zones'), id = 'p' + Date.now().toString(36), address = clean_(req.address, 300) || m.address;
  var pk = { merchantId: mid, merchantName: m.business, phone: m.phone, address: address,
             area: clean_(req.area, 80) || m.area, zoneId: zoneFor_(clean_(req.area, 80) || m.area, zones),
             date: clean_(req.date, 20), window: clean_(req.window, 40), notes: clean_(req.notes, 300),
             codes: mine, count: Math.max(mine.length, Number(req.count) || 0), status: 'requested', riderId: '',
             createdAt: now_(), updatedAt: now_(), history: [{ status: 'requested', at: now_() }] };
  var docs = {};
  mine.forEach(function (c) { orders[c].pickupId = id; orders[c].updatedAt = now_(); docs[c] = orders[c]; });
  writeMany_('pickups', single_(id, pk));
  if (mine.length) writeMany_('orders', docs);
  return { id: id, date: pk.date, window: pk.window, count: pk.count, status: pk.status };
}

/* ================= Riders ================= */

function riderLogin(phone, pin) {
  var key = 'rlogin:' + normPhone_(phone);
  guardFails_(key);
  var rs = readCol_('riders');
  for (var id in rs) {
    var r = rs[id];
    if (r.pinHash && normPhone_(r.phone) === normPhone_(phone) && r.pinHash === hash_(id, pin)) {
      return { token: makeToken_('r', id), rider: { id: id, name: r.name } };
    }
  }
  noteFail_(key);
  throw new Error('Wrong phone number or PIN. Ask the office to set your rider PIN.');
}

function riderData(token) {
  var rid = checkToken_(token, 'r'), r = readCol_('riders')[rid];
  if (!r) throw new Error('Please sign in again.');
  var orders = readCol_('orders'), pickups = readCol_('pickups'), list = [], pks = [];
  for (var c in orders) {
    var o = orders[c];
    if (o.riderId !== rid) continue;
    if (o.status === 'pickup' || o.status === 'out' || o.status === 'at_hub' || isToday_(o.updatedAt)) list.push(o);
  }
  for (var p in pickups) {
    var pk = pickups[p];
    if (pk.riderId === rid && (pk.status === 'assigned' || isToday_(pk.updatedAt))) { pk.id = p; pks.push(pk); }
  }
  return { rider: { id: rid, name: r.name, location: r.location || '', offDuty: !!r.offDuty },
           orders: list, pickups: pks, company: (readCol_('settings').company || {}).name || '' };
}

function riderAction(token, a) {
  var rid = checkToken_(token, 'r');
  a = a || {};
  return withLock_(function () {
    var rider = readCol_('riders')[rid];
    if (a.type === 'pickup') {
      var pks = readCol_('pickups'), pk = pks[a.id];
      if (!pk || pk.riderId !== rid) throw new Error('This pickup is not assigned to you.');
      if (a.action !== 'collected') throw new Error('Unknown action.');
      collectPickup_(a.id, pk, Number(a.count) || pk.count, 'Collected by ' + rider.name);
      return true;
    }
    var orders = readCol_('orders'), o = orders[normCode_(a.id)];
    if (!o || o.riderId !== rid) throw new Error('This order is not assigned to you.');
    if (a.action === 'collected' && o.status === 'pickup') { o.riderId = ''; addHistory_(o, 'at_hub', 'Collected by ' + rider.name); }
    else if (a.action === 'delivered' && o.status === 'out') { recordPod_(o, a.pod, rider.name); addHistory_(o, 'delivered', 'Delivered by ' + rider.name); o.remitted = false; }
    else if (a.action === 'failed' && o.status === 'out') addHistory_(o, 'failed', clean_(a.note, 200) || 'Rider could not deliver');
    else throw new Error('This order has already moved on. Pull down to refresh.');
    writeMany_('orders', single_(o.code, o));
    return true;
  });
}

function riderLocation(token, text) {
  var rid = checkToken_(token, 'r');
  return withLock_(function () {
    var r = readCol_('riders')[rid];
    r.location = clean_(text, 120); r.locationAt = now_();
    writeMany_('riders', single_(rid, r));
    return true;
  });
}

/* ================= Staff ================= */

function staffLogin(pin) { checkPin_(pin); return true; }

function staffGetAll(pin) {
  checkPin_(pin);
  var ms = readCol_('merchants'), merchants = {};
  for (var id in ms) merchants[id] = publicMerchant_(id, ms[id]);
  var rs = readCol_('riders');
  for (var r in rs) { rs[r].hasPin = !!rs[r].pinHash; delete rs[r].pinHash; }
  return { orders: readCol_('orders'), riders: rs, settings: readCol_('settings'), zones: readCol_('zones'),
           merchants: merchants, pickups: readCol_('pickups') };
}

function staffSet(pin, col, id, obj) {
  checkPin_(pin);
  var docs = {}; docs[String(id)] = obj;
  return staffSetMany(pin, col, docs);
}

function staffSetMany(pin, col, docs) {
  checkPin_(pin);
  if (COLS.indexOf(col) < 0) throw new Error('Unknown record type.');
  return withLock_(function () {
    if (col === 'riders' || col === 'merchants') {
      var cur = readCol_(col);
      for (var id in docs) {
        var keep = cur[id] || {};
        ['pinHash', 'pwHash', 'salt'].forEach(function (k) { if (keep[k]) docs[id][k] = keep[k]; else delete docs[id][k]; });
        delete docs[id].hasPin;
      }
    }
    writeMany_(col, docs);
    return true;
  });
}

function staffDelete(pin, col, id) {
  checkPin_(pin);
  if (COLS.indexOf(col) < 0) throw new Error('Unknown record type.');
  return withLock_(function () {
    var sh = sheet_(col), row = rowIndex_(sh)[String(id)];
    if (row) sh.deleteRow(row);
    delete CACHE_[col];
    return true;
  });
}

function staffSetRiderPin(pin, riderId, riderPin) {
  checkPin_(pin);
  if (!/^\d{4,6}$/.test(String(riderPin))) throw new Error('A rider PIN must be 4 to 6 digits.');
  return withLock_(function () {
    var r = readCol_('riders')[riderId];
    if (!r) throw new Error('Rider not found.');
    r.pinHash = hash_(riderId, riderPin);
    writeMany_('riders', single_(riderId, r));
    return true;
  });
}

function staffPod(pin, code, pod) {
  checkPin_(pin);
  return withLock_(function () {
    var o = readCol_('orders')[normCode_(code)];
    if (!o) throw new Error('Order not found.');
    recordPod_(o, pod, 'office');
    addHistory_(o, 'delivered', pod && pod.note ? clean_(pod.note, 200) : 'Delivered');
    o.remitted = false;
    writeMany_('orders', single_(o.code, o));
    return o;
  });
}

function staffAssignPickup(pin, id, riderId) {
  checkPin_(pin);
  return withLock_(function () {
    var pk = readCol_('pickups')[id], r = readCol_('riders')[riderId];
    if (!pk) throw new Error('Pickup not found.');
    if (!r) throw new Error('Choose a rider.');
    pk.riderId = riderId; pk.status = 'assigned'; pk.updatedAt = now_();
    pk.history = (pk.history || []).concat([{ status: 'assigned', at: now_(), note: 'Rider: ' + r.name }]);
    var orders = readCol_('orders'), docs = {};
    (pk.codes || []).forEach(function (c) {
      var o = orders[c];
      if (o && (o.status === 'booked' || o.status === 'pickup')) { o.riderId = riderId; addHistory_(o, 'pickup', 'Rider: ' + r.name); docs[c] = o; }
    });
    writeMany_('pickups', single_(id, pk));
    if (Object.keys(docs).length) writeMany_('orders', docs);
    return true;
  });
}

function staffCollectPickup(pin, id, count) {
  checkPin_(pin);
  return withLock_(function () {
    var pk = readCol_('pickups')[id];
    if (!pk) throw new Error('Pickup not found.');
    collectPickup_(id, pk, Number(count) || pk.count, 'Received at office');
    return true;
  });
}

// Assigns riders by zone and current workload. Deliveries at the office get a rider (staff then send them out),
// customer pickups and vendor pickups get a rider straight away.
function staffAutoAssign(pin) {
  checkPin_(pin);
  return withLock_(function () {
    var orders = readCol_('orders'), riders = readCol_('riders'), pickups = readCol_('pickups'), zones = readCol_('zones');
    var pool = Object.keys(riders).filter(function (id) { return !riders[id].offDuty; });
    if (!pool.length) throw new Error('No riders are on duty.');
    var load = {};
    pool.forEach(function (id) { load[id] = 0; });
    for (var c in orders) { var o = orders[c]; if (load.hasOwnProperty(o.riderId) && (o.status === 'out' || o.status === 'pickup' || o.status === 'at_hub')) load[o.riderId]++; }
    for (var p in pickups) { var pk = pickups[p]; if (load.hasOwnProperty(pk.riderId) && pk.status === 'assigned') load[pk.riderId] += 2; }

    function choose(zoneId) {
      var inZone = pool.filter(function (id) { return (riders[id].zones || []).indexOf(zoneId) >= 0; });
      if (!inZone.length) inZone = pool.filter(function (id) { return !(riders[id].zones || []).length; });
      if (!inZone.length) inZone = pool;
      inZone.sort(function (a, b) { return load[a] - load[b] || String(riders[a].name).localeCompare(String(riders[b].name)); });
      return inZone[0];
    }

    var oDocs = {}, pDocs = {}, n = { deliveries: 0, pickups: 0, vendorPickups: 0 };
    Object.keys(pickups).sort(byCreated_(pickups)).forEach(function (id) {
      var pk = pickups[id];
      if (pk.status !== 'requested') return;
      var rid = choose(pk.zoneId || zoneFor_(pk.area, zones));
      pk.riderId = rid; pk.status = 'assigned'; pk.updatedAt = now_();
      pk.history = (pk.history || []).concat([{ status: 'assigned', at: now_(), note: 'Rider: ' + riders[rid].name }]);
      load[rid] += 2; pDocs[id] = pk; n.vendorPickups++;
      (pk.codes || []).forEach(function (c) {
        var o = orders[c];
        if (o && o.status === 'booked') { o.riderId = rid; addHistory_(o, 'pickup', 'Rider: ' + riders[rid].name); oDocs[c] = o; }
      });
    });
    Object.keys(orders).sort(byCreated_(orders)).forEach(function (c) {
      var o = orders[c];
      if (oDocs[c]) return;
      if (o.status === 'at_hub' && !o.riderId) {
        var rid = choose(o.zoneId || zoneFor_(o.receiver && o.receiver.area, zones));
        o.riderId = rid; o.updatedAt = now_(); load[rid]++; oDocs[c] = o; n.deliveries++;
      } else if (o.status === 'booked' && !o.riderId && !o.pickupId && !o.merchantId && o.sender && o.sender.address && o.sender.address.charAt(0) !== '(') {
        var rid2 = choose(zoneFor_(o.sender.address, zones) || o.zoneId);
        o.riderId = rid2; addHistory_(o, 'pickup', 'Rider: ' + riders[rid2].name); load[rid2]++; oDocs[c] = o; n.pickups++;
      }
    });
    if (Object.keys(pDocs).length) writeMany_('pickups', pDocs);
    if (Object.keys(oDocs).length) writeMany_('orders', oDocs);
    return n;
  });
}

/* ================= Shared order logic ================= */

function newOrder_(orders, zones, f, note) {
  var code;
  do { code = newCode_(); } while (orders[code]);
  var area = clean_(f.receiver.area, 80), zoneId = zoneFor_(area, zones), z = zoneId && zones[zoneId];
  var t = now_();
  return {
    code: code, status: 'booked', source: f.source, merchantId: f.merchantId || '', merchantName: f.merchantName || '',
    ref: f.ref || '', createdAt: t, updatedAt: t,
    sender: { name: clean_(f.sender.name, 120), phone: clean_(f.sender.phone, 40), address: clean_(f.sender.address, 300) },
    receiver: { name: clean_(f.receiver.name, 120), phone: clean_(f.receiver.phone, 40),
                address: clean_(f.receiver.address, 300), area: area },
    zoneId: zoneId, item: clean_(f.item, 200), size: clean_(f.size, 60) || 'Small (envelope / nylon)',
    fee: z && z.fee != null && z.fee !== '' ? Number(z.fee) : null,
    feeBy: String(f.feeBy || '').toLowerCase().indexOf('receiver') === 0 ? 'receiver' : 'sender',
    collect: Math.max(0, Number(String(f.collect || '').replace(/[^\d.]/g, '')) || 0),
    due: clean_(f.due, 40) || 'Today', notes: clean_(f.notes, 500), riderId: '',
    history: [{ status: 'booked', at: t, note: note }]
  };
}

function collectPickup_(id, pk, count, note) {
  var orders = readCol_('orders'), docs = {};
  (pk.codes || []).forEach(function (c) {
    var o = orders[c];
    if (o && (o.status === 'booked' || o.status === 'pickup')) { o.riderId = ''; addHistory_(o, 'at_hub', note); docs[c] = o; }
  });
  pk.status = 'collected'; pk.collectedCount = count; pk.updatedAt = now_();
  pk.history = (pk.history || []).concat([{ status: 'collected', at: now_(), note: note + ' (' + count + ' packages)' }]);
  writeMany_('pickups', single_(id, pk));
  if (Object.keys(docs).length) writeMany_('orders', docs);
}

function recordPod_(o, pod, by) {
  pod = pod || {};
  var name = clean_(pod.receivedBy, 120);
  if (!name) throw new Error('Enter the name of the person who received the package.');
  var rec = { receivedBy: name, at: now_(), by: by, note: clean_(pod.note, 200), signatureUrl: '', photoUrl: '' };
  if (pod.signature) rec.signatureUrl = saveImage_(pod.signature, o.code + '-signature');
  if (pod.photo) rec.photoUrl = saveImage_(pod.photo, o.code + '-photo');
  o.pod = rec;
}

function saveImage_(dataUrl, name) {
  var m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(String(dataUrl));
  if (!m) return '';
  var bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > 3 * 1024 * 1024) throw new Error('That photo is too large. Try again with a smaller photo.');
  var folder = podFolder_();
  var file = folder.createFile(Utilities.newBlob(bytes, m[1], name + (m[2] === 'png' ? '.png' : '.jpg')));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800';
}

function podFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('POD_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('Dispatch Desk proof of delivery');
  props.setProperty('POD_FOLDER', f.getId());
  return f;
}

function addHistory_(o, status, note) {
  o.status = status; o.updatedAt = now_();
  o.history = (o.history || []).concat([{ status: status, at: o.updatedAt, note: note || '' }]);
}

function merchantView_(o, riders) {
  var r = o.riderId && riders[o.riderId];
  return { code: o.code, ref: o.ref, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
           receiver: o.receiver, item: o.item, fee: o.fee, feeBy: o.feeBy, collect: o.collect, notes: o.notes,
           pickupId: o.pickupId || '', rider: r && (o.status === 'out' || o.status === 'pickup') ? { name: r.name, phone: r.phone } : null,
           pod: o.pod ? { receivedBy: o.pod.receivedBy, at: o.pod.at, signatureUrl: o.pod.signatureUrl, photoUrl: o.pod.photoUrl } : null,
           history: o.history };
}

function publicMerchant_(id, m) {
  return { id: id, business: m.business, contact: m.contact, phone: m.phone, email: m.email,
           address: m.address, area: m.area, active: m.active !== false, createdAt: m.createdAt };
}

function zoneList_() {
  var zs = readCol_('zones'), out = [];
  for (var id in zs) out.push({ id: id, name: zs[id].name, areas: zs[id].areas || [], fee: zs[id].fee });
  return out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

function zoneFor_(area, zones) {
  var a = String(area || '').toLowerCase().trim();
  if (!a) return '';
  for (var id in zones) {
    var list = zones[id].areas || [];
    for (var i = 0; i < list.length; i++) {
      var z = String(list[i]).toLowerCase().trim();
      if (z && (a === z || a.indexOf(z) >= 0 || z.indexOf(a) >= 0)) return id;
    }
  }
  return '';
}

/* ================= Storage in the Google Sheet ================= */

var CACHE_ = {};

function book_() {
  if (CACHE_.book) return CACHE_.book;
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SHEET_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) { ss = SpreadsheetApp.create('Dispatch Desk data'); props.setProperty('SHEET_ID', ss.getId()); }
  return (CACHE_.book = ss);
}

function sheet_(col) {
  var ss = book_(), name = col.charAt(0).toUpperCase() + col.slice(1), sh = ss.getSheetByName(name);
  var h = HEADERS[col];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
    var first = ss.getSheetByName('Sheet1');
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  } else if (sh.getLastColumn() !== h.length || String(sh.getRange(1, h.length).getValue()) !== 'data') {
    migrate_(sh, col);
  }
  return sh;
}

// Older sheets had fewer columns. Rewrite them in the new layout, keeping every record.
function migrate_(sh, col) {
  var n = sh.getLastRow(), w = sh.getLastColumn(), docs = {};
  if (n >= 2 && w >= 2) {
    var vals = sh.getRange(2, 1, n - 1, w).getValues();
    vals.forEach(function (row) { try { if (row[0]) docs[String(row[0])] = JSON.parse(row[w - 1]); } catch (e) {} });
  }
  sh.clear();
  var h = HEADERS[col];
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
  sh.setFrozenRows(1);
  var ids = Object.keys(docs);
  if (ids.length) {
    var ctx = {};
    sh.getRange(2, 1, ids.length, h.length).setValues(ids.map(function (id) { return mirror_(col, id, docs[id], ctx); }));
  }
}

function readCol_(col) {
  if (CACHE_[col]) return clone_(CACHE_[col]);
  var sh = sheet_(col), n = sh.getLastRow(), out = {};
  if (n >= 2) {
    var w = HEADERS[col].length, vals = sh.getRange(2, 1, n - 1, w).getValues();
    for (var i = 0; i < vals.length; i++) {
      var id = String(vals[i][0]); if (!id) continue;
      try { out[id] = JSON.parse(vals[i][w - 1]); } catch (e) {}
    }
  }
  CACHE_[col] = out;
  return clone_(out);
}

function rowIndex_(sh) {
  var n = sh.getLastRow(), idx = {};
  if (n < 2) return idx;
  sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r, i) { if (r[0] !== '') idx[String(r[0])] = i + 2; });
  return idx;
}

// Writes many records with as few sheet calls as possible (important for bulk uploads).
function writeMany_(col, docs) {
  var sh = sheet_(col), idx = rowIndex_(sh), ctx = {}, fresh = [], w = HEADERS[col].length;
  Object.keys(docs).forEach(function (id) {
    var line = mirror_(col, id, docs[id], ctx);
    if (idx[id]) sh.getRange(idx[id], 1, 1, w).setValues([line]);
    else fresh.push(line);
  });
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, w).setValues(fresh);
  delete CACHE_[col];
}

function mirror_(col, id, o, ctx) {
  var json = JSON.stringify(o);
  if (json.length > 49000) throw new Error('A record is too large to save.');
  if (col === 'orders') {
    ctx.riders = ctx.riders || readCol_('riders');
    ctx.zones = ctx.zones || readCol_('zones');
    var r = o.riderId && ctx.riders[o.riderId], z = o.zoneId && ctx.zones[o.zoneId], s = o.sender || {}, v = o.receiver || {};
    return [id, o.status, o.createdAt, o.merchantName || '', s.name, s.phone, s.address, v.name, v.phone, v.address, v.area,
            z ? z.name : '', o.item, o.fee == null ? '' : o.fee, o.feeBy, o.collect || 0, r ? r.name : '',
            o.pod ? o.pod.receivedBy : '', o.updatedAt, json];
  }
  if (col === 'riders') {
    ctx.zones = ctx.zones || readCol_('zones');
    var zn = (o.zones || []).map(function (zid) { return ctx.zones[zid] ? ctx.zones[zid].name : ''; }).filter(String).join(', ');
    return [id, o.name, o.phone, o.plate || '', zn, o.offDuty ? 'yes' : '', o.location || '', o.locationAt || '', json];
  }
  if (col === 'zones') return [id, o.name, (o.areas || []).join(', '), o.fee == null ? '' : o.fee, json];
  if (col === 'merchants') return [id, o.business, o.contact, o.phone, o.email || '', o.address, o.createdAt, o.active === false ? 'no' : 'yes', json];
  if (col === 'pickups') {
    ctx.riders = ctx.riders || readCol_('riders');
    var pr = o.riderId && ctx.riders[o.riderId];
    return [id, o.merchantName, o.phone, o.address, o.date, o.window, o.count, o.status, pr ? pr.name : '', o.updatedAt, json];
  }
  return [id, o.name || '', json];
}

/* ================= Security and helpers ================= */

function checkPin_(pin) {
  guardFails_('pin');
  if (String(pin) !== String(STAFF_PIN)) { noteFail_('pin'); throw new Error('Wrong staff PIN.'); }
}

function guardFails_(key) {
  if (Number(CacheService.getScriptCache().get('fail:' + key) || 0) >= 15) {
    throw new Error('Too many wrong tries. Please wait 10 minutes and try again.');
  }
}
function noteFail_(key) {
  var c = CacheService.getScriptCache(), k = 'fail:' + key;
  c.put(k, String(Number(c.get(k) || 0) + 1), 600);
}

function throttle_(key, max) {
  var c = CacheService.getScriptCache(), k = 'rl:' + key, n = Number(c.get(k) || 0);
  if (n >= max) throw new Error('Too many requests. Please wait a few minutes and try again.');
  c.put(k, String(n + 1), 600);
}

function secret_() {
  var props = PropertiesService.getScriptProperties(), s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret_())).replace(/=+$/, '');
}

function makeToken_(role, id) {
  var body = role + '.' + id + '.' + (Date.now() + 30 * 24 * 3600 * 1000);
  return body + '.' + sign_(body);
}

function checkToken_(token, role) {
  var p = String(token || '').split('.');
  if (p.length !== 4 || p[0] !== role) throw new Error('Please sign in again.');
  var body = p.slice(0, 3).join('.');
  if (sign_(body) !== p[3] || Number(p[2]) < Date.now()) throw new Error('Please sign in again.');
  return p[1];
}

function hash_(salt, text) {
  var v = String(salt) + ':' + String(text);
  for (var i = 0; i < 300; i++) {
    v = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v + salt));
  }
  return v;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function requireFields_(f, names) {
  for (var i = 0; i < names.length; i++) {
    if (!clean_(f[names[i]], 300)) throw new Error('Missing ' + names[i].replace(/([A-Z])/g, ' $1').toLowerCase() + '.');
  }
}

function single_(id, o) { var d = {}; d[id] = o; return d; }
function byCreated_(m) { return function (a, b) { return String(m[a].createdAt).localeCompare(String(m[b].createdAt)); }; }
function clone_(o) { return JSON.parse(JSON.stringify(o)); }
function now_() { return new Date().toISOString(); }
function isToday_(iso) {
  if (!iso) return false;
  var tz = 'Africa/Lagos', f = 'yyyy-MM-dd';
  return Utilities.formatDate(new Date(iso), tz, f) === Utilities.formatDate(new Date(), tz, f);
}
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function firstName_(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function normPhone_(p) { var d = String(p || '').replace(/\D/g, ''); if (d.indexOf('234') === 0) d = '0' + d.slice(3); return d; }
function normCode_(code) {
  code = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (code && code.indexOf('DD-') !== 0) code = 'DD-' + code.replace(/^DD/, '');
  return code;
}
function newCode_() {
  var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 6; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return 'DD-' + s;
}
