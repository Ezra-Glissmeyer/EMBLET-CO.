# Phase 4 test script — POS, sales orders, returns & exchanges

Hard-refresh the site first (Ctrl+Shift+R / Cmd+Shift+R). Run the SQL checks in **Supabase → SQL Editor** (Run this query). Every transaction below is posted by an RPC function: `post_sale`, `process_return`, `process_exchange`, `create_sales_order`, `fulfill_sales_order`, `close_sales_order`, `cancel_sales_order`, `record_customer_payment`. Step F proves nothing else can write those tables.

**Before you start**, run this "counter" query and keep the numbers:
```sql
select (select count(*) from sales) sales, (select count(*) from sale_lines) sale_lines, (select count(*) from payments) payments,
       (select count(*) from returns) returns, (select count(*) from inventory_transactions) ledger, (select count(*) from gl_entries) gl,
       (select sum(debit)-sum(credit) from gl_entries) gl_out_of_balance;
```

---

## A. POS sale with discounts, cash and receipt (sign in as cashier)
1. **Point of Sale** (Storefront – Provo). Scan or type + Enter `EMB20001` **twice**, then `EMB30003` once. **Expect:** 2 cart lines: Ezra's Embers ×2 and Oatmeal Hearth ×1. Scanning the same code twice raises the qty instead of adding a line.
2. Oatmeal line: discount type **% off**, value `10`. Order discount: **$**, `5`.
   **Expect:** Subtotal $56.50 · Line discounts −$0.85 · Order discount −$5.00 · Sales tax (7.25%) $3.67 · **Total $54.32**.
3. Click **💵 Cash**, Cash tendered `60`. **Expect:** "Change due: $5.68".
4. **Complete sale.** **Expect:** a toast "Sale R-0xxxx complete · $54.32" and the receipt opens. It shows the logo, Emblet Co., Storefront – Provo, receipt #, date, Cashier Casey Cashier, both lines, the line discount, the order discount, tax, TOTAL $54.32, Paid by CASH, a barcode of the receipt # and the return policy.
5. **🖨 Print receipt** opens the print dialog with just the receipt. Write down the receipt number.

**Rows that change** (re-run the counter query):

| Table | Change |
|---|---|
| sales | **+1** |
| sale_lines | **+2** |
| payments | **+1** |
| ledger | **+2** (two `SALE` rows, negative qty) |
| gl | **+6** |
| gl_out_of_balance | still **0.00** |

```sql
select receipt_no, payment_method, subtotal, line_discounts, order_discount, tax, total from sales order by id desc limit 1;
-- CASH | 56.50 | 0.85 | 5.00 | 3.67 | 54.32
select account_code, debit, credit from gl_entries where ref_no = (select receipt_no from sales order by id desc limit 1) order by id;
-- 1000 Dr 54.32 | 4100 Dr 5.85 | 4000 Cr 56.50 | 2100 Cr 3.67 | 5000 Dr COGS | 1210 Cr COGS
```

## B. Not enough stock
1. Scan **Liz's Lavender soap** (`EMB30001`) more times than the storefront has (the card shows "N here").
2. **Expect:** red "Only N at STR" on the line, a red box under the totals, and **Complete sale is greyed out**.
3. Click **Check other locations**. **Expect:** a table of the other locations' stock with **Transfer N here** buttons. Clicking one posts a `TRANSFER` (2 ledger rows) and the sale can then complete.
4. Click **Clear** to empty the cart.

## C. Returns (still the cashier) → **Returns & Exchanges**
1. Scan / type the receipt # from A and press Enter. The receipt's lines appear.
2. **Quality return to QA Hold:** on CND-EZRA set Return qty `1`, Reason **Candle tunneling (quality)**.
   - **Expect:** Disposition switches to **QA Hold** by itself, Refund method is **Cash refund** (the original tender), and Refund total ≈ **$23.44**.
   - Click **Process**. **Expect:** "Return RT-… processed · refunded $23.44".
3. **Restock return:** on SOAP-OAT set qty `1`, Reason **Customer changed mind** → **Expect:** Disposition **Restock** → **Process**. That line now says "fully returned".

**Rows that change:**
```sql
select r.return_no, r.refund_method, r.refund_total, l.reason_code, l.disposition, l.qty
from returns r join return_lines l on l.return_id = r.id order by r.id desc limit 2;
-- TUNNELING / QA_HOLD   and   CHANGED_MIND / RESTOCK
select location_code, txn_type, qty from inventory_transactions where txn_type = 'RETURN' order by id desc limit 2;
-- QAH +1 (Ezra, not sellable)   and   STR +1 (Oatmeal, back on the shelf)
select account_code, debit, credit from gl_entries where ref_no = (select return_no from returns order by id desc limit 1 offset 1) order by account_code;
-- 1000 Cr refund | 1210 Dr cost back | 2100 Dr tax | 4200 Dr Sales Returns & Allowances | 5000 Cr COGS
```

## D. Exchange
1. Same receipt → **Exchange** tab. CND-EZRA qty `1`, Reason **Wrong scent / not as expected**.
2. In **Replacement items**, scan `EMB20005` (Timp Sunrise, $25).
   **Expect:** Exchange credit ≈ $23.42, New items (incl. tax) $26.81, "**Customer pays** ≈ $3.39".
3. **Process.** **Expect:** "Exchange done (RT-… → EX-…). Customer paid $3.39" and an exchange receipt opens.
```sql
select e.price_difference, s.receipt_no, s.payment_method from exchanges e join sales s on s.id = e.new_sale_id order by e.id desc limit 1;
-- ≈ 3.39 | EX-xxxxx | EXCHANGE_CREDIT
```
**Inventory moves both ways:** Ezra +1 back to the storefront, Timp Sunrise −1.

## E. Sales order status flow & backorders → **Sales Orders**
1. **+ New sales order:** Customer **Ava Nielsen**, Location **Storefront – Provo**, add one candle whose storefront stock you know (e.g. Tie-Dye Ty), with a qty **3 more** than the store has. **Create order.**
   ```sql
   select so_no, status, channel from sales_orders order by id desc limit 1;   -- ORDER_PLACED | PHONE
   ```
2. Click the order → **Ship now** is pre-filled with what's on hand → **📦 Fulfill / ship.**
   **Expect:** "Shipped on INV-… · order is now partially fulfilled", and an invoice/receipt opens.
   ```sql
   select o.status, l.qty_ordered, l.qty_fulfilled, l.backordered from sales_orders o join so_lines l on l.so_id = o.id order by o.id desc limit 1;
   -- PARTIALLY_FULFILLED | 9 | 6 | true   (example numbers)
   ```
3. **Backorders** tab. **Expect:** the line with its open and short qty, an **Est. available** date, and what that date is based on (open production order, open PO, or today + lead time).
4. Move 3 more to the Storefront (Inventory → Transfer from Workshop). Then open the order again → **Fulfill / ship.** **Expect:** "order is now fulfilled", and the order lists **2 invoices**.
5. **Close order.** **Expect:** status **CLOSED**.
6. Create another small order and click **Cancel order** before shipping. **Expect:** **CANCELLED**. A shipped order can't be cancelled; it can only be closed.

## F. Wholesale → A/R → return by SO # → payment (sign in as manager)
1. **+ New sales order:** Customer **Red Cliffs Gift Co. (wholesale)**, change Location to **Storefront – Provo**, add **SOAP-OAT** qty `6` → Create → open it → **Fulfill / ship**.
   ```sql
   select a.invoice_no, a.amount, a.due_date, s.tax, s.payment_method
   from ar_invoices a join sales s on s.id = a.sale_id order by a.id desc limit 1;
   -- INV-… | 28.08 (6 × $4.68 wholesale = 55% of $8.50) | today + 30 | 0.00 (resale-exempt) | ACCOUNT
   ```
2. **Returns & Exchanges** → type the **SO number** (e.g. `SO-00271`) + Enter. **Expect:** it finds that order's invoice.
   Return 1 SOAP-OAT, Reason **Damaged in transit**. **Expect:** Disposition **Scrap**, and Refund **Credit wholesale account (open balance $28.08)**. **Process** → "$4.68".
   ```sql
   select amount, amount_paid, status from ar_invoices order by id desc limit 1;   -- 23.40 | 0 | OPEN
   ```
3. **Sales Orders → Receivables (A/R)** tab. Find the invoice → **Record payment** → `10` → "still open: $13.40 left". Then **Record payment** again (it pre-fills $13.40) → "invoice is PAID".
   ```sql
   select count(*) from ar_payments where invoice_id = (select max(id) from ar_invoices);   -- 2
   select account_code, sum(debit) dr, sum(credit) cr from gl_entries where ref_type = 'AR_PAYMENT'
    and ref_no = (select invoice_no from ar_invoices order by id desc limit 1) group by 1;   -- 1000 Dr 23.40 | 1100 Cr 23.40
   ```

## G. Proof that only the RPC functions can post transactions
Signed in as the **manager**, press F12 → Console and paste:
```js
const m = await import('./js/lib/db.js');
[(await m.sb.from('sales').insert({ receipt_no: 'HACK-1', location_code: 'STR', channel: 'POS', subtotal: 1, tax_rate: 0, tax: 0, total: 1, payment_method: 'CASH' })).error?.message,
 (await m.sb.from('inventory_transactions').insert({ item_id: 1, location_code: 'STR', qty: 100, txn_type: 'ADJUSTMENT' })).error?.message,
 (await m.sb.from('sales_orders').update({ status: 'CLOSED' }).neq('id', 0).select()).data?.length]
```
**Expect:** `['permission denied for table sales', 'new row violates row-level security policy for table "inventory_transactions"', 0]`. Even a manager can't write sales or ledger rows or change an order's status directly. Only the functions can.

---
**Final check:** re-run the counter query. **gl_out_of_balance = 0.00**.
**Clean up:** run `sql/04_seed.sql` again before the demo.
