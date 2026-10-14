# Setting up your delivery website

The website has two parts:

- **The pages** (`index.html`, `config.js`) are hosted on Vercel. Every change pushed to this GitHub repository goes live on its own.
- **The server** (`apps-script/Code.gs`) runs free on Google Apps Script. It saves everything in a Google Sheet called **Dispatch Desk data** in your Google Drive, with one tab each for Orders, Riders, Zones, Merchants (vendors), Pickups and Settings. Delivery photos and signatures go in a Drive folder called **Dispatch Desk proof of delivery**.

## Your links

| Who | Link | What they do |
|---|---|---|
| Customers | `https://<your-site>.vercel.app` | Book one delivery, see the zone fee, track a package |
| Track one package | `https://<your-site>.vercel.app/?track=DD-XXXXXX` | Opens straight to that package |
| Vendors | `https://<your-site>.vercel.app/?merchant=1` | Create an account, upload orders in bulk, book pickups, download reports |
| Riders | `https://<your-site>.vercel.app/?rider=1` | See their run, mark pickups collected, record proof of delivery |
| Staff | `https://<your-site>.vercel.app/?staff=1` | Dispatch board, auto-assign, zones, riders, vendors, all orders (needs the staff PIN) |

The **Links to share** button on the staff board copies all of these.

## Updating the server (do this after every new `Code.gs`)

1. Open **script.google.com** and open your project.
2. Click **Code.gs**, select everything and delete it, then paste in the whole of `apps-script/Code.gs` from this repository.
3. Near the top, set `var STAFF_PIN = '2468';` back to **your own PIN**. Click the save icon.
4. If the project still has an **Index.html** file, you can delete it (three dots next to it → Delete). The website no longer uses it.
5. Click **Deploy → Manage deployments**, click the pencil icon, set Version to **New version**, then **Deploy**. The `/exec` address stays the same, so `config.js` doesn't change.
6. Google may ask you to **Authorize access** again, because the server now saves delivery photos to your Drive. Choose your account. If you see "Google hasn't verified this app", click **Advanced → Go to Dispatch Desk (unsafe) → Allow**.

Optional: put your website address in `var SITE_URL = '';` (for example `'https://yourcompany.vercel.app'`). Anyone who opens the old Apps Script link is then sent to the website.

## First things to do on the staff board

1. Click **Set your company name** at the top.
2. **Zones** tab: add your delivery zones, the areas in each (separated by commas) and the fee. For example *Mainland*: Yaba, Surulere, Ikeja, ₦2,500. Orders whose area matches a zone get that fee automatically.
3. **Riders** tab: add each rider, tick the zones they cover (none ticked means any zone), and give them a 4 to 6 digit **PIN**. They sign in on the rider link with their phone number and that PIN.
4. Send vendors the vendor link. They create their own account.

## How a day works

- Customers book on the main link. Vendors add orders one at a time or upload a CSV of up to 500 at once, and can book a pickup from their shop at the same time.
- On the board, **Auto-assign riders** gives every vendor pickup, customer pickup and package at the office to the least busy on-duty rider who covers that zone.
- Riders see their pickups on their phone and tap **Collected**. The packages show up **At our office**.
- Click **Auto-assign riders** again to give the office packages a rider, then **Send out all assigned**.
- At the door the rider taps **Delivered**, types who received it, and gets a signature on the screen (a photo is optional). Customers and vendors see who received it.
- Vendors see delivered, pending and failed orders on **My orders**, and can download the list or copy a summary.

## First-time setup (only if starting from scratch)

1. On **script.google.com**, click **New project** and name it *Dispatch Desk*.
2. Paste `apps-script/Code.gs` into Code.gs and set your PIN.
3. **Deploy → New deployment →** gear icon **→ Web app**. Execute as **Me**, Who has access **Anyone**. Deploy and authorize.
4. Copy the Web app URL (it ends in `/exec`) into `config.js`.
5. On **vercel.com**, **Add New → Project**, choose this repository, **Deploy**.

## Good to know

- Customers only see their own package, by its tracking code: the receiver's first name and area, the status, who received it, and the rider's name and phone while it's moving.
- Vendors only see their own orders. Riders only see the jobs assigned to them.
- Vendor passwords and rider PINs are stored scrambled (hashed), never as plain text. Too many wrong tries locks that phone number out for 10 minutes.
- You can pause a vendor account on the **Vendors** tab.
