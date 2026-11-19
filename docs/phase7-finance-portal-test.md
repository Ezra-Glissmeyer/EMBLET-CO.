# Phase 7 test script — P&L, valuation, turnover, dashboard, reports, customer portal

Hard-refresh every browser first (Ctrl+Shift+R / Cmd+Shift+R). This phase includes a **Realtime fix**: the "New pickup order" pop-up never fired before. Run SQL in **Supabase → SQL Editor** (Run this query).

You'll use **two windows**: a normal one for staff, and a private/incognito window (or your phone) for the customer.

---

## A. Profit & loss → **Financials** (manager)
1. The period defaults to **Last 12 months**. **Expect** the tiles: Net sales, Gross profit + margin %, Operating expenses, Net income, and **Trial balance: Balanced ✔**.
2. The P&L table reads, top to bottom:
   - Gross sales revenue, less discounts, less returns & allowances = **Net sales**
   - Cost of goods sold, giving **Gross profit**
   - Write-offs and adjustments, then Wages, Rent, Utilities, Marketing and Card fees, giving **Operating income**
   - Other income (purchase discounts), giving **Net income**

   Each line has its % of net sales. The **By month** chart shows the holiday spike in Nov–Dec.
3. Prove it's built from the GL. Use the same dates as the From / To boxes on screen:
   ```sql
   select sum(credit-debit) filter (where account_code='4000') gross_sales,
          sum(credit-debit) filter (where account_code in ('4000','4100','4200')) net_sales,
          sum(debit-credit) filter (where account_code='5000') cogs,
          sum(debit) - sum(credit) as out_of_balance
     from gl_entries where entry_date between current_date - 364 and current_date;
   ```
   **Expect:** the same Gross sales, Net sales and COGS as the screen, and `out_of_balance = 0`.
4. **Live:** switch Period to **Month to date** and note Net sales. In another window, as the cashier, ring up **2 × Ezra's Embers** ($48.00). Back on Financials, click **Refresh**. **Expect:** Net sales is **exactly $48.00 higher**.

## B. Inventory valuation → **Inventory valuation** tab
**Expect:**
- Tiles for Raw materials, Finished goods and Work in process, each with the matching GL balance underneath (1200 / 1210 / 1250).
- A "By location" table (WKS / WHS / STR / QAH).
- A "By item" table with qty per location × avg cost = value, plus an **Export CSV** button.

```sql
select sum(qty*avg_cost) filter (where i.item_type = 'raw') raw_value, sum(qty*avg_cost) filter (where i.item_type <> 'raw') finished_value
  from inventory_balances b join items i on i.id = b.item_id;
select account_code, sum(debit-credit) from gl_entries where account_code in ('1200','1210','1250') group by 1;
```
**Expect:** the tiles match the first query. The GL balances match within about $1 (weighted-average rounding, explained in the blue note).

## C. Inventory turnover → **Inventory turnover** tab
**Expect** rows for **overall** (COGS basis), **Raw Materials** and **Finished Goods**, then each category (candle 8oz, soap, wax, fragrance…). Each row has COGS / usage, begin / end / average inventory, **Turns / yr** and **Days on hand**. Overall is about **2.9 turns, ~125 days**.
```sql
select scope, label, cost_of_usage, avg_inventory, turnover, days_on_hand from fn_turnover(current_date - 364, current_date) where scope <> 'category';
-- turnover ≈ cost_of_usage ÷ avg_inventory   (annualised);   days_on_hand = avg_inventory ÷ (cost_of_usage ÷ 365)
```

## D. Manager dashboard → **Dashboard**
**Expect** KPI tiles:
- Today's net sales (with transaction and unit counts)
- Gross margin (30 days)
- Month-to-date
- **Items below ROP** (red)
- Open sales orders (pickups, backordered lines)
- Open purchase orders (late ones)
- **Past-due invoices** (red, $ owed)
- Production running / planned / QA hold
- Inventory value (A/R and A/P open)

Below them: a 30-day stacked sales chart by channel, the open orders queue, and the low-stock list with suggested qty and order-by date.
```sql
select fn_dashboard_kpis();   -- every tile's number comes from this one function
```
**Live:** keep the dashboard open and make a sale in the cashier's window. **Expect:** Today's net sales and transactions go up within a second or two, with **no refresh**.

## E. Reports → **Reports**
Defaults to the last 12 months, by month. **Expect** these sections:
- Net sales by month (stacked by channel)
- Sales by location and by channel (doughnuts + tables with share %)
- Top sellers by revenue and by units (Ezra's Embers is #1 by revenue)
- Slow movers (units sold, on hand, days since last sale)
- Profit by scent family
- Low stock with suggested qty and order-by date
- Inventory by location (units by type)
- Supplier performance (quoted vs actual lead time, on-time, fill, rating)
- Returns by reason code (quality reasons in red)
- Quality-failure returns by product, with return rate %
- A full returns table

Switch **Sales by** to Week or Day and **Run reports** to see the seasonality.

## F. Customer portal + pickup ordering (Realtime)
1. **Staff window:** sign in as the **cashier** → **Sales Orders**. Note the number of rows in **Storefront pickup queue** and the badge next to "Sales Orders" in the sidebar. Leave this window alone from now on.
2. **Customer window:** sign in as `customer@emblet.test` / `EmbletCustomer!1`. **Expect:**
   - The **Shop** shows 26 products with mock-up images, scent notes, description and price.
   - Each card shows availability, e.g. "46 at Storefront · 0 at Warehouse".
   - Only Shop, My Orders and About are in the menu.
3. **Add** Ezra's Embers twice and Oatmeal Hearth once → **🛍️ Pickup bag (3)**. **Expect:** Estimated total **$56.50**, "Plus Utah sales tax. Pay at pickup."
4. Set **Pickup date** to a **Sunday** → **Place pickup order**. **Expect:** "Storefront – Provo is closed on Sundays — please pick another day." Change it to a Monday → **Place pickup order**. **Expect:** "Thanks! Order SO-… placed", and you land on **My Orders** with "Order placed — we're getting it ready".
   ```sql
   select so_no, channel, status, location_code, requested_date, created_by from sales_orders order by id desc limit 1;
   -- ONLINE_PICKUP | ORDER_PLACED | STR | the Monday | Hannah's user id
   select item_id, qty_ordered, unit_price from so_lines where so_id = (select max(id) from sales_orders);   -- 2 lines: 2 × 24.00, 1 × 8.50
   ```
5. **Staff window (no refresh!).** Within a second or two **expect**:
   - a blue pop-up "🛍️ New pickup order SO-… — see Sales Orders"
   - the order appears in the **Storefront pickup queue**
   - the sidebar badge goes up by 1
6. Cashier: open the order → **📦 Fulfill / ship** → "…order is now fulfilled". In the customer window, **My Orders** changes to **Picked up** live, and a receipt button **INV-… · $60.60** appears. Click it: the receipt lists Ezra's Embers and Oatmeal Hearth, with $4.10 tax.
   ```sql
   select o.status, s.receipt_no, s.total, s.tax from sales_orders o join sales s on s.sales_order_id = o.id order by o.id desc limit 1;   -- FULFILLED | INV-… | 60.60 | 4.10
   ```
7. **Cancel works too:** place another small order as the customer, then on My Orders click **Cancel order**. **Expect:** status **Cancelled**, and it disappears from the cashier's queue live.

## G. Wholesale portal & customer security
1. In the customer window, sign out and sign in as `parkcity@emblet.test` / `EmbletWholesale!1` (Main Street Mercantile). **Expect:**
   - A note that prices are **wholesale (55% of retail)**, invoiced Net 30, tax-exempt.
   - Ezra's Embers shows **$13.20** with ~~$24.00~~ struck through.
   - The pickup bag says "Invoiced to your account, Net 30. No sales tax (resale)."
   - The order's `so_lines.unit_price` = **13.20**.
2. As any customer, press F12 → Console and paste:
   ```js
   const m = await import('./js/lib/db.js');
   [Object.keys((await m.sb.from('v_catalog').select('*').limit(1)).data[0]), (await m.sb.from('items').select('avg_cost')).data.length, (await m.sb.from('gl_entries').select('id').limit(1)).data.length]
   ```
   **Expect:**
   - the catalogue columns with **no cost columns**
   - `0` items
   - `0` GL rows

   Customers can't see costs, other customers or internal data; the database (RLS) blocks it.

---
**Final check:** `select sum(debit) - sum(credit) from gl_entries;` → **0.00**. Re-run `sql/04_seed.sql` before the demo, which also removes the test orders.
