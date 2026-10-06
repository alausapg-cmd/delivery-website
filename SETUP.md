# Put your delivery website online (free)

The website runs on Google Apps Script, which is free with a Google account. All orders and riders are saved in a Google Sheet called **Dispatch Desk data** in your Google Drive, so you can open it any time.

You get one web address. Customers use it to book a delivery and track a package, and they don't need any account. Your staff add `?staff=1` to the end of the address and type a PIN to open the dispatch board.

## Steps (about 10 minutes, on a computer)

1. Go to **script.google.com** and sign in with the Google account the business will use.
2. Click **New project**. Click "Untitled project" at the top and rename it, for example *Dispatch Desk*.
3. **Code.gs**: delete everything in the editor, then paste in the whole of `apps-script/Code.gs`.
4. **Change the staff PIN**: near the top, find `var STAFF_PIN = '2468';` and replace 2468 with your own PIN. Click the save icon.
5. **Index page**: click the **+** next to "Files", choose **HTML**, and name it `Index` (capital I, no `.html`). Delete what's in it and paste in the whole of `apps-script/Index.html`. Save.
6. Click **Deploy** → **New deployment**. Click the gear icon next to "Select type" and choose **Web app**. Set:
   - Description: *Website*
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy**. Google asks you to **Authorize access**: choose your account. If you see "Google hasn't verified this app", click **Advanced** → **Go to Dispatch Desk (unsafe)** → **Allow**. This warning is normal for scripts you write yourself.
8. Copy the **Web app URL** (it ends in `/exec`). That is your website.

## Hosting the pages on Vercel (optional, nicer address)

Vercel gives you an address like `yourcompany.vercel.app` with no Google banner. The orders still live in your Google Sheet. Apps Script stays as the engine behind the site.

1. Finish steps 1–8 above first and copy the `/exec` address.
2. The website files are in this repository. Put that address in `config.js` (Claude can do this for you).
3. The folder goes into a GitHub repository (Claude can push it there).
4. On **vercel.com**, sign in with GitHub, then **Add New → Project** → choose the repository → **Deploy**.
5. Your links become `https://<name>.vercel.app` for customers and `https://<name>.vercel.app/?staff=1` for staff.

Every later change pushed to the repository goes live on Vercel automatically. A change to `Code.gs` still has to be published again in Apps Script.

## Your links

| Who | Link |
|---|---|
| Customers: book and track | `https://script.google.com/macros/s/…/exec` |
| Track one package directly | `…/exec?track=DD-7K3Q` |
| Staff dispatch board | `…/exec?staff=1` |

Put the customer link on your WhatsApp status, Instagram bio and business profile. In the staff board, the **Customer page link** button copies it. Every message you copy for a customer includes a link straight to their tracking page.

## First things to do on the staff board

- Click **Set your company name** at the top so it shows on the customer page and in messages.
- Add your riders on the **Riders** tab.
- Customer bookings arrive in **New bookings** marked "Booked online". Open each one and set the delivery fee.

## Making changes later

If you paste new code, you must publish it again: **Deploy** → **Manage deployments** → pencil icon → Version: **New version** → **Deploy**. The web address stays the same.

## Good to know

- The staff board refreshes every 20 seconds, so everyone sees new orders without reloading.
- Customers can only see their own package, and only by its tracking code. They see the receiver's first name and area, the status, and the rider's name and phone while the package is moving. They never see addresses, other phone numbers or other orders.
- Google shows a small grey banner on Apps Script sites saying "This application was created by a Google Apps Script user". That is normal on the free plan.
- Want a nicer address like `www.yourcompany.com.ng`? You can buy a domain and set it to redirect to this address.
