# Emblet Co. — Mini ERP / MRP

A working mini-ERP for **Emblet Co.**, a fictional Utah company that hand-pours candles and makes melt-and-pour soap, sells them in its Provo storefront and online for pickup, and wholesales to boutiques in Park City, St. George and Logan. Built for **GSCM 401 – Operations Management**.

**Stack:** static HTML + CSS + vanilla JavaScript (ES modules, no build step) on **GitHub Pages**, with **Supabase** (Postgres, Auth, Row Level Security, Realtime) as the back end. All business logic lives in Postgres functions.

---

## 1. Setup (about 10 minutes)

1. **Create a Supabase project** at <https://supabase.com> (the free tier is fine). Wait until it finishes provisioning.
2. **Run the SQL files in order** in *Supabase → SQL Editor → New query*. Paste each whole file and click **Run**:
   1. `sql/01_schema.sql`: tables (drops and rebuilds everything Emblet-related)
   2. `sql/02_functions.sql`: transaction RPCs, reports, ROP/EOQ, MRP, forecast
   3. `sql/03_rls.sql`: Row Level Security, grants, signup trigger, Realtime publication
   4. `sql/04_seed.sql`: demo users, master data and a **14-month simulated history** (takes ~30–90 s)

   The seed is **re-runnable**: run `04_seed.sql` again at any time (e.g. the morning of the demo) to reset all data. All dates are relative to *today*, so the data never goes stale. To rebuild from scratch, run all four again in order.
3. **Configure the front end.** In *Supabase → Project Settings → API*, copy the **Project URL** and the **anon public** key into `config.js`:
   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```
   The anon key is meant to be public, and RLS protects the data. **Never** put the `service_role` key in this repo.
4. **Publish to GitHub Pages.** Push this folder to a public GitHub repo, then go to *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*. After a minute the site is live at `https://<user>.github.io/<repo>/`.
5. (Optional) In *Supabase → Authentication → URL Configuration*, set the Site URL to your GitHub Pages URL.

> Running locally: any static server works, e.g. `python3 -m http.server 8000`, then open <http://localhost:8000>. Camera scanning needs HTTPS or `localhost`.

## 2. Demo logins

| Role | Email | Password | Lands on |
|---|---|---|---|
| Admin (everything + user roles) | `admin@emblet.test` | `EmbletAdmin!1` | Dashboard |
| Manager | `manager@emblet.test` | `EmbletManager!1` | Dashboard |
| Cashier | `cashier@emblet.test` | `EmbletCashier!1` | Point of Sale |
| Production | `production@emblet.test` | `EmbletProduction!1` | Production |
| Customer (Hannah Whitaker) | `customer@emblet.test` | `EmbletCustomer!1` | Shop |
| Customer (Mia Fonoti) | `mia@emblet.test` | `EmbletCustomer!1` | Shop |
| Wholesale customer (Main Street Mercantile) | `parkcity@emblet.test` | `EmbletWholesale!1` | Shop (orders are priced at wholesale) |

Each navigation menu shows only that role's pages, and the **database** enforces the same rules through RLS and role checks in every RPC. Hidden buttons are not the only protection.

## 3. What's in the box

| Module | Where | Highlights |
|---|---|---|
| Point of Sale | `#/pos` | Scan (USB / phone / webcam) or tap; qty edit; line & order discounts (% or $); tax from settings; stock check with "check other locations → transfer here"; printable receipt with a barcode |
| Inventory | `#/inventory` | Item × location grid with filters; transfers; adjustments with reason codes (posted to the GL); blind cycle counts; full item ledger |
| Barcode labels | `#/labels` | Code 128, Avery 5160-style sheets (30/page) |
| Sales orders | `#/orders` | Wholesale, phone and website pickups; partial fulfilment; backorders with an estimated available date; live pickup queue |
| Returns & exchanges | `#/returns` | Scan the receipt; reason codes; restock / QA Hold / scrap; exchanges with the price difference; QA Hold inspection |
| Production | `#/production` | Create → Issue (blocks and lists short components) → Complete (good / scrap / reason / actual times); report with FPY, scrap by reason, throughput, cycle time, on-time %, cost variance |
| Purchasing | `#/purchasing` | POs with printable "sent" view; scan-to-receive (full or partial, days early/late); A/P invoices with terms, due dates, 2/10 discount |
| Suppliers | `#/suppliers` | CRUD + scorecard (on-time, lead time actual vs quoted, fill rate, payments, Keep / Watch / Replace) |
| Reorder review | `#/reorder` | Live ROP, safety stock, EOQ per item, with "show math"; one-click POs grouped by supplier or production orders |
| MRP | `#/mrp` | 4–8 week time-phased grid, recursive BOM explosion, lot-for-lot or EOQ, pegging, convert planned orders |
| ❄ Holiday Readiness Planner | `#/planner` | **Wow feature.** Forecast = last year's same weeks × growth trend; a what-if slider re-runs MRP and shows which materials run out and when |
| Financials | `#/financials` | P&L for any date range, inventory valuation (sub-ledger vs GL), turnover and days on hand, journal |
| Reports | `#/reports` | Sales by day/week/month, location and channel; top sellers; slow movers; low stock; supplier lead times; returns by reason and product; profit by scent family |
| Customer portal | `#/shop`, `#/myorders` | Branded storefront with product mock-ups, availability by location, pickup ordering, live order status |
| About | `#/about` | AI tools, platform, libraries, data model, formulas |

## 4. Architecture rules (how to explain it)

- **Every number is computed** from stored data by SQL views and functions (`fn_pnl`, `fn_reorder_metrics`, `fn_turnover`, `v_supplier_scorecard`…). Nothing is hard-coded.
- **Every transaction is one atomic Postgres function:** `post_sale`, `process_return`, `process_exchange`, `transfer_inventory`, `adjust_inventory`, `cycle_count`, `create_sales_order`, `fulfill_sales_order`, `create_purchase_order`, `receive_purchase_order`, `record_supplier_payment`, `issue_production_order`, `complete_production_order`, `run_mrp`. It either fully posts or fully fails, even with several users at once.
- **`inventory_transactions` is the single source of truth.** `inventory_balances` is maintained from it by a trigger, can never go negative, and `v_ledger_reconciliation` proves the two match.
- **Double-entry GL** (`gl_entries`). Every journal is checked to balance before it commits. Accounts: Cash, A/R, Inventory–RM, Inventory–FG, WIP, A/P, Sales Tax Payable, Sales Revenue, Sales Discounts, Sales Returns & Allowances, COGS, Scrap/Write-off, Inventory Adjustment, operating expenses, Purchase Discounts.
- **Weighted-average cost** is updated on every receipt and every production completion. Finished-good cost = actual components issued ÷ good units, so scrap raises unit cost. Returns come back at the original cost.
- **History was generated by simulation through the same functions**, so COGS, turnover, EOQ and ROP all agree with the ledger.
- **Realtime:** the app subscribes to inventory, sales, orders, POs, production, returns and invoices. A sale on one screen updates other screens within about a second.

## 5. The story in the data (good demo moments)

- **Cabin Cocoa fragrance oil (FO-COCOA)** is nearly out: a jug went cloudy (see its ledger: `EXPIRED_FRAGRANCE`), right before the holiday rush. MRP shows a **past-due** release date and the Planner flags it.
- **Large Gift Box (BOX-LG)** and **8 oz wicks (WCK-08)** are below ROP. Issuing the planned Mallow Mal production order is **blocked with a list of short components**.
- **Suppliers:** Bonneville Wax = Keep (always on time, complete); Sage & Ember Fragrance = Watch (often late); Great Basin Glass & Tin = **Replace** (short-ships and is late, and has past-due invoices).
- **Main Street Mercantile** placed a big holiday order (gift sets → candles → wax and oils), which drives most of the MRP shortages; use **Pegging** to show it.
- **Cache Valley Goods** has a partially shipped order with backordered lines.
- **Quality:** Beehive Honey (beeswax blend) has the highest scrap rate (frosting, sinkholes) and "wick drowned" returns; Tie-Dye Ty gets "weak scent throw" returns.
- **Liz's Lavender soap** is sold out at the storefront, so you can show the POS stock block and "check other locations".

### Suggested 10-minute flow

1. **Cashier on phone + manager on laptop.** Ring up a sale on the phone (scan a label with the camera); the manager's dashboard updates live.
2. Return a candle for **TUNNELING** to QA Hold; show the GL reversal in Financials → General ledger.
3. A customer places a pickup order, which pops up in the cashier's queue. Fulfil it.
4. **Reorder:** change the ordering cost in the panel and watch every EOQ change; click *Show math*.
5. **MRP:** run it, open the FO-COCOA record (past-due release), click *Pegging*, then convert planned orders.
6. **Production:** issue (shortage dialog), then complete with scrap and show actual vs standard cost.
7. **Planner:** drag to +40% and watch which materials run out and when.
8. **Suppliers:** scorecard and past-due invoices; pay one.

## 6. Troubleshooting

- **"config.js still has placeholder values"**: fill in step 3.
- **Login says "Email or password is incorrect"**: re-run `04_seed.sql` (it recreates the demo users).
- **"Realtime offline" badge**: the app still works; refresh to reconnect. Realtime needs `03_rls.sql` to have run (it adds the tables to the `supabase_realtime` publication).
- **Camera does not open**: the site must be HTTPS (GitHub Pages is), the browser needs camera permission, and on iPhone use Safari. You can always type the code and press Enter. USB scanners work in any scan box.
- **Labels print the wrong size**: print at 100% / "Actual size", margins none, letter paper.
- **The seed timed out in the SQL editor**: run it again (it starts with `set statement_timeout = 0`). It normally finishes in under a minute.

## 7. Repo layout

```
index.html            app shell (loads libraries from CDNs)
config.js             Supabase URL + anon key (edit me)
css/styles.css        brand styles (sage #9CAF88, tan #C8A27A, cream #F5EBDD)
assets/logo-mark.svg  logo
js/app.js             auth, role-based navigation, router, realtime status
js/lib/               db client, UI kit, scanner, realtime bus, printable docs, product mock-ups
js/pages/             one module per screen
sql/01..04            database (run in order)
```
