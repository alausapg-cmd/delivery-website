# Delivery website

A website for a delivery business. Customers book a delivery and track their package. Staff use the dispatch board to receive orders, assign riders and send packages out.

- `index.html`, `config.js`: the website (hosted on Vercel)
- `apps-script/`: the server, which runs free on Google Apps Script and saves everything to a Google Sheet

Links once deployed:
- Customers: `https://<your-site>.vercel.app`
- Track a package: `https://<your-site>.vercel.app/?track=DD-XXXX`
- Staff: `https://<your-site>.vercel.app/?staff=1` (needs the staff PIN)

Setup steps are in [SETUP.md](SETUP.md).
