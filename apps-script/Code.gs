/**
 * Dispatch Desk website: Google Apps Script server.
 *
 * Customers:  <web app URL>              book a delivery, track a package
 * Staff:      <web app URL>?staff=1      dispatch board (needs the staff PIN)
 *
 * All records live in a Google Sheet called "Dispatch Desk data" in your Drive.
 * It is created automatically the first time the site is used.
 */

// CHANGE THIS before you deploy. Staff type it to open the dispatch board.
var STAFF_PIN = '2468';

var COLS = ['orders', 'riders', 'settings'];
var HEADERS = {
  orders: ['Code', 'Status', 'Booked at', 'Sender', 'Sender phone', 'Pickup address', 'Receiver', 'Receiver phone',
           'Delivery address', 'Area', 'Item', 'Fee (₦)', 'Fee paid by', 'Collect (₦)', 'Rider', 'Last update', 'data'],
  riders: ['ID', 'Name', 'Phone', 'Plate', 'Zone', 'Off duty', 'Last location', 'Location time', 'data'],
  settings: ['Key', 'Value', 'data']
};

/* ---------------- Web page ---------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var t = HtmlService.createTemplateFromFile('Index');
  t.mode = p.staff ? 'staff' : 'customer';
  t.track = String(p.track || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  t.siteUrl = ScriptApp.getService().getUrl();
  var name = getSettings_().company && getSettings_().company.name;
  return t.evaluate()
    .setTitle(name ? name + ' · Deliveries' : 'Dispatch Desk')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/* ---------------- Public functions (customers) ---------------- */

function publicInfo() {
  var s = getSettings_();
  return { company: (s.company && s.company.name) || '' };
}

function bookOrder(f) {
  f = f || {};
  var need = ['senderName', 'senderPhone', 'receiverName', 'receiverPhone', 'receiverAddress', 'area', 'item'];
  for (var i = 0; i < need.length; i++) {
    if (!clean_(f[need[i]], 200)) throw new Error('Please fill in every required field.');
  }
  if (f.arrive === 'pickup' && !clean_(f.senderAddress, 300)) throw new Error('Please add your pickup address.');
  throttle_('book:' + clean_(f.senderPhone, 40), 10);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var existing = readCol_('orders');
    var code;
    do { code = newCode_(); } while (existing[code]);
    var now = new Date().toISOString();
    var o = {
      code: code, status: 'booked', source: 'customer', createdAt: now, updatedAt: now,
      sender: { name: clean_(f.senderName, 120), phone: clean_(f.senderPhone, 40),
                address: f.arrive === 'pickup' ? clean_(f.senderAddress, 300) : '(Customer will drop off at office)' },
      receiver: { name: clean_(f.receiverName, 120), phone: clean_(f.receiverPhone, 40),
                  address: clean_(f.receiverAddress, 300), area: clean_(f.area, 80) },
      item: clean_(f.item, 200), size: clean_(f.size, 60), fee: null,
      feeBy: f.feeBy === 'receiver' ? 'receiver' : 'sender',
      collect: Math.max(0, Number(f.collect) || 0), due: clean_(f.due, 40) || 'Today',
      notes: clean_(f.notes, 500), riderId: '',
      history: [{ status: 'booked', at: now, note: 'Booked online by customer' }]
    };
    writeDoc_('orders', code, o);
    return { code: code };
  } finally {
    lock.releaseLock();
  }
}

function trackOrder(code) {
  code = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (code && code.indexOf('DD-') !== 0) code = 'DD-' + code.replace(/^DD/, '');
  throttle_('track', 300);
  var o = readCol_('orders')[code];
  if (!o) return null;
  var r = o.riderId ? readCol_('riders')[o.riderId] : null;
  var showRider = r && (o.status === 'out' || o.status === 'pickup');
  // Only what the customer needs. No phone numbers of sender/receiver, no notes.
  return {
    code: o.code, status: o.status, item: o.item, fee: o.fee, feeBy: o.feeBy,
    receiver: { name: firstName_(o.receiver && o.receiver.name), area: o.receiver && o.receiver.area },
    rider: showRider ? { name: r.name, phone: r.phone } : null,
    history: (o.history || []).map(function (h) { return { status: h.status, at: h.at }; })
  };
}

/* ---------------- Staff functions (need the PIN) ---------------- */

function staffLogin(pin) { checkPin_(pin); return true; }

function staffGetAll(pin) {
  checkPin_(pin);
  return { orders: readCol_('orders'), riders: readCol_('riders'), settings: readCol_('settings') };
}

function staffSet(pin, col, id, obj) {
  checkPin_(pin);
  if (COLS.indexOf(col) < 0) throw new Error('Unknown record type.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { writeDoc_(col, String(id), obj); } finally { lock.releaseLock(); }
  return true;
}

function staffDelete(pin, col, id) {
  checkPin_(pin);
  if (COLS.indexOf(col) < 0) throw new Error('Unknown record type.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(col), row = findRow_(sh, String(id));
    if (row) sh.deleteRow(row);
  } finally { lock.releaseLock(); }
  return true;
}

/* ---------------- Storage in the Google Sheet ---------------- */

function book_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var ss = SpreadsheetApp.create('Dispatch Desk data');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheet_(col) {
  var ss = book_();
  var name = col.charAt(0).toUpperCase() + col.slice(1);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[col].length).setValues([HEADERS[col]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    var first = ss.getSheetByName('Sheet1');
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}

function readCol_(col) {
  var sh = sheet_(col), n = sh.getLastRow(), out = {};
  if (n < 2) return out;
  var w = HEADERS[col].length;
  var vals = sh.getRange(2, 1, n - 1, w).getValues();
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][0]); if (!id) continue;
    try { out[id] = JSON.parse(vals[i][w - 1]); } catch (e) {}
  }
  return out;
}

function findRow_(sh, id) {
  var n = sh.getLastRow(); if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

function writeDoc_(col, id, obj) {
  var sh = sheet_(col), row = findRow_(sh, id);
  var line = mirror_(col, id, obj);
  if (row) sh.getRange(row, 1, 1, line.length).setValues([line]);
  else sh.appendRow(line);
}

// Readable columns so the business can open the sheet and see everything. The last column is the full record.
function mirror_(col, id, o) {
  var json = JSON.stringify(o);
  if (col === 'orders') {
    var riders = readCol_('riders'), r = o.riderId && riders[o.riderId];
    var s = o.sender || {}, v = o.receiver || {};
    return [id, o.status, o.createdAt, s.name, s.phone, s.address, v.name, v.phone, v.address, v.area, o.item,
            o.fee == null ? '' : o.fee, o.feeBy, o.collect || 0, r ? r.name : '', o.updatedAt, json];
  }
  if (col === 'riders') {
    return [id, o.name, o.phone, o.plate, o.zone, o.offDuty ? 'yes' : '', o.location || '', o.locationAt || '', json];
  }
  return [id, o.name || '', json];
}

function getSettings_() { try { return readCol_('settings'); } catch (e) { return {}; } }

/* ---------------- Helpers ---------------- */

function checkPin_(pin) {
  var c = CacheService.getScriptCache(), fails = Number(c.get('pinfail') || 0);
  if (fails >= 20) throw new Error('Too many wrong PINs. Please wait 10 minutes and try again.');
  if (String(pin) !== String(STAFF_PIN)) {
    c.put('pinfail', String(fails + 1), 600);
    throw new Error('Wrong staff PIN.');
  }
}

// Simple abuse guard: at most `max` calls per key per 10 minutes.
function throttle_(key, max) {
  var c = CacheService.getScriptCache(), k = 'rl:' + key, n = Number(c.get(k) || 0);
  if (n >= max) throw new Error('Too many tries. Please wait a few minutes and try again.');
  c.put(k, String(n + 1), 600);
}

function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function firstName_(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function newCode_() {
  var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 4; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return 'DD-' + s;
}

/* ---------------- JSON API (used when the pages are hosted elsewhere, e.g. Vercel) ---------------- */

var API = {
  publicInfo: publicInfo, bookOrder: bookOrder, trackOrder: trackOrder,
  staffLogin: staffLogin, staffGetAll: staffGetAll, staffSet: staffSet, staffDelete: staffDelete
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API.hasOwnProperty(req.fn) ? API[req.fn] : null;
    if (!fn) throw new Error('Unknown request.');
    out = { ok: true, result: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
