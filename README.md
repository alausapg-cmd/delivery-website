# Delivery website

A website for a delivery business, with pages for customers, vendors, riders and staff.

- `index.html`, `config.js`: the website (hosted on Vercel)
- `apps-script/Code.gs`: the server, which runs free on Google Apps Script and saves everything to a Google Sheet

| Who | Link |
|---|---|
| Customers: book and track | `https://<your-site>.vercel.app` |
| Vendors: bulk orders, pickups, reports | `https://<your-site>.vercel.app/?merchant=1` |
| Riders: run sheet and proof of delivery | `https://<your-site>.vercel.app/?rider=1` |
| Staff: dispatch board (needs the PIN) | `https://<your-site>.vercel.app/?staff=1` |

Setup and update steps are in [SETUP.md](SETUP.md).
