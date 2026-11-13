# Phase 1 test script — database & seed

Run these in **Supabase → SQL Editor**, one step at a time, in a **new query tab** for each step. Choose **Run this query** (not "Run and enable RLS"). The editor shows only the result of the **last** statement, so each step ends with the check query you should look at.

When you run SQL from the editor you are the database owner, so the role checks inside the functions are skipped. That is what lets you call `post_sale` etc. directly here. Step 8 then proves that real logins *are* restricted.

> Start from a fresh seed: run `sql/04_seed.sql` once before Step 1. Numbers like receipt numbers and exact quantities differ a little from run to run, because the history is generated relative to today's date. Check the **changes** (before vs after), not the exact values.

---

## The snapshot query (used in every step)

Save this as a snippet called **snapshot**. Run it before and after each step and compare.

```sql
select
  (select count(*) from sales)                     as sales,
  (select count(*) from sale_lines)                as sale_lines,
  (select count(*) from returns)                   as returns,
  (select count(*) from inventory_transactions)    as ledger_rows,
  (select count(*) from gl_entries)                as gl_rows,
  (select count(*) from po_receipts)               as po_receipts,
  (select count(*) from ap_invoices)               as ap_invoices,
  (select count(*) from production_orders where status = 'COMPLETED') as mos_done,
  (select qty from inventory_balances b join items i on i.id = b.item_id where i.sku = 'CND-EZRA' and location_code = 'STR') as ezra_at_store,
  (select coalesce(sum(qty),0) from inventory_balances where location_code = 'QAH') as qa_hold_units,
  (select sum(debit) - sum(credit) from gl_entries) as gl_out_of_balance,
  (select count(*) from v_ledger_reconciliation where difference <> 0) as ledger_mismatches;
```

**Expected every time:** `gl_out_of_balance = 0.00` and `ledger_mismatches = 0`. If either is ever not zero, stop. Something is broken.

---

## Step 1 — The seed loaded

```sql
select 'items' t, count(*) from items union all
select 'bom_lines', count(*) from bom_lines union all
select 'customers', count(*) from customers union all
select 'suppliers', count(*) from suppliers union all
select 'demo logins', count(*) from profiles union all
select 'POS + invoice sales', count(*) from sales union all
select 'open sales orders', count(*) from sales_orders where status in ('ORDER_PLACED','PARTIALLY_FULFILLED') union all
select 'open purchase orders', count(*) from purchase_orders where status in ('ORDER_SENT','PARTIALLY_RECEIVED') union all
select 'production in progress', count(*) from production_orders where status = 'IN_PROGRESS' union all
select 'past-due A/P invoices', count(*) from ap_invoices where status = 'OPEN' and due_date < app.today();
```

**Expect:** items **70**, bom_lines **139**, customers **14**, suppliers **6**, demo logins **7**, sales **≈ 7,000–7,500**, open sales orders exactly **9**, open purchase orders **≈ 8–15**, production in progress exactly **2**, past-due invoices **≥ 2**.

---

## Step 2 — A POS sale (`post_sale`)

1. Run **snapshot**. Write down `sales`, `sale_lines`, `ledger_rows`, `gl_rows`, `ezra_at_store`.
2. Run:

```sql
select post_sale(
  'STR',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where sku = 'CND-EZRA'), 'qty', 2),
    jsonb_build_object('item_id', (select id from items where sku = 'SOAP-OAT'), 'qty', 1, 'disc_type', 'PCT', 'disc_value', 10)),
  5, 'AMT', 'CARD');
```

**Expect:** `{"tax": 3.67, "total": 54.32, "sale_id": …, "receipt_no": "R-0xxxx"}`. The math: gross 2 × $24 + $8.50 = $56.50; 10% off the soap = −$0.85; $5 order discount spread across the lines by value = −$5.00; net **$50.65**; 7.25% tax per line = **$3.67**; total **$54.32**.

3. Look at what it wrote:

```sql
select account_code, debit, credit, memo
from gl_entries
where ref_no = (select receipt_no from sales order by id desc limit 1)
order by id;
```

**Expect 6 GL lines:** Dr 1000 Cash **54.32**, Dr 4100 Sales Discounts **5.85**, Cr 4000 Sales Revenue **56.50**, Cr 2100 Sales Tax Payable **3.67**, Dr 5000 COGS and Cr 1210 Inventory – Finished Goods for the same amount (≈ $10.60, i.e. 2 candles + 1 soap at weighted-average cost). Debits = credits = $70.77 + COGS.

4. Run **snapshot** again. **Expect:** `sales` +1, `sale_lines` +2, `ledger_rows` +2 (two `SALE` rows with negative qty), `gl_rows` +6, `ezra_at_store` −2.

## Step 3 — Overselling is blocked

```sql
select post_sale('STR', jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku = 'CND-EZRA'), 'qty', 9999)));
```

**Expect:** a red error `INSUFFICIENT_STOCK: CND-EZRA Ezra's Embers — need 9999, only … on hand at STR.` Run **snapshot**: nothing changed, because the whole function rolled back.

## Step 4 — A quality return to QA Hold (`process_return`)

```sql
select process_return(
  (select max(id) from sales where channel = 'POS'),
  jsonb_build_array(jsonb_build_object(
    'sale_line_id', (select min(id) from sale_lines where sale_id = (select max(id) from sales where channel = 'POS')),
    'qty', 1, 'reason_code', 'TUNNELING', 'disposition', 'QA_HOLD')),
  'CARD');
```

**Expect:** `{"return_no": "RT-…", "refund_total": …}`. Run **snapshot**: `returns` +1, `ledger_rows` +1 (a `RETURN` row into **QAH**), `qa_hold_units` +1, `gl_rows` +5 (Dr 4200 Returns & Allowances, Dr 2100 tax, Cr 1000 refund, Dr 1210 / Cr 5000 to put the cost back). `ezra_at_store` is **unchanged**, because QA Hold is not sellable.

```sql
select qty, qty_returned from sale_lines where id = (select min(id) from sale_lines where sale_id = (select max(id) from sales where channel = 'POS'));
```
**Expect:** `qty_returned = 1`.

## Step 5 — Receive a purchase order (`receive_purchase_order`)

1. Pick an open PO and note the first item's average cost:

```sql
select p.id po_id, p.po_no, s.name supplier, p.expected_date, s.payment_terms,
       i.sku, l.qty_ordered, l.unit_cost, i.avg_cost as avg_cost_before,
       (select sum(qty) from inventory_balances where item_id = i.id) as on_hand_before
from purchase_orders p join suppliers s on s.id = p.supplier_id
join po_lines l on l.po_id = p.id join items i on i.id = l.item_id
where p.status = 'ORDER_SENT' order by p.expected_date, l.line_no limit 1;
```

2. Receive the full first line (put the `po_id` you saw in **both** places):

```sql
select receive_purchase_order(PO_ID, 'WKS',
  (select jsonb_agg(jsonb_build_object('po_line_id', id, 'qty', qty_ordered)) from po_lines where po_id = PO_ID and line_no = 1));
```

**Expect:** `{"receipt_no": "RCV-…", "days_late": …, "po_status": "RECEIVED" or "PARTIALLY_RECEIVED", "invoice_no": "AP-RCV-…"}`. A negative `days_late` means early.

3. Check the cost and the invoice:

```sql
select i.sku, i.avg_cost as avg_cost_after, a.invoice_no, a.amount, a.invoice_date, a.due_date, a.discount_date
from ap_invoices a join receipt_lines rl on rl.receipt_id = a.receipt_id join items i on i.id = rl.item_id
order by a.id desc limit 1;
```

**Expect:**
- `avg_cost_after = (on_hand_before × avg_cost_before + qty_ordered × unit_cost) ÷ (on_hand_before + qty_ordered)` (weighted average).
- `due_date` = receipt date + 15 / 30 / 45 days per the supplier's terms. For **2/10 Net 30**, `discount_date` = receipt date + 10.
- **snapshot:** `po_receipts` +1, `ap_invoices` +1, `ledger_rows` +1 (`PO_RECEIPT`), and `gl_rows` +2 (Dr Inventory, Cr 2000 Accounts Payable).

## Step 6 — Make soap (`create` → `issue` → `complete` production order)

```sql
select create_production_order((select id from items where sku = 'SOAP-BROOKE'), 24, 'WKS');
```
**Expect:** `{"mo_id": …, "mo_no": "MO-…"}`.

```sql
select issue_production_order((select max(id) from production_orders));
```
**Expect:** `{"status": "IN_PROGRESS", "component_cost": …, "lot_no": "LOT-…"}`. This consumes 24 × the BOM: 6.48 lb glycerin base, 3.6 oz eucalyptus fragrance oil, 0.24 oz mint colorant, 24 wraps and 24 labels. If a component is short you get `SHORT_COMPONENTS:[…]` listing exactly what is missing, and nothing is consumed.

```sql
select complete_production_order((select max(id) from production_orders), 22, 2, 'AIR_BUBBLES',
                                 now() - interval '2 hours', now());
```
**Expect:** `{"status": "COMPLETED", "qty_good": 22, "actual_unit_cost": …, "std_unit_cost": …}`, where `actual_unit_cost = component_cost ÷ 22`. The 2 scrapped bars are absorbed into the good ones, so actual comes out above standard.

```sql
select txn_type, count(*), sum(qty) from inventory_transactions
where ref_no = (select mo_no from production_orders order by id desc limit 1) group by 1;
```
**Expect:** `PROD_ISSUE` with **5** rows (one per component, negative qty) and `PROD_RECEIPT` with 1 row of **+22**. GL account **1250 Work in Process** nets to the same total as before (debited at issue, credited at completion).

## Step 7 — MRP (`run_mrp`)

```sql
select run_mrp(4, 'LFL');
```
**Expect:** `{"run_id": …, "items_planned": …, "planned_orders": …, "past_due": …}` with `past_due ≥ 1`.

```sql
select i.sku, l.llc as bom_level, l.week_no, l.gross_req, l.sched_receipts, l.proj_on_hand, l.planned_receipt, l.release_date, l.past_due
from mrp_lines l join items i on i.id = l.item_id
where l.run_id = (select max(id) from mrp_runs) and l.planned_receipt > 0
order by l.llc, l.release_date;
```

**Expect:** gift sets at level 0 (e.g. KIT-HOLIDAY, KIT-COZY), candles such as CND-COCOA at level 1, and raw materials at level 2. **FO-COCOA** (Cabin Cocoa fragrance oil) has `past_due = true`: the order-by date has already passed.

```sql
select source_no, customer_name, path, qty from mrp_pegging
where run_id = (select max(id) from mrp_runs) and item_id = (select id from items where sku = 'FO-COCOA');
```
**Expect:** pegging rows back to sales orders such as Main Street Mercantile's holiday order, with paths like `Cozy Cabin Kit → Cabin Cocoa → Fragrance Oil – Hot Chocolate & Peppermint`.

## Step 8 — Security by role (RLS)

This pretends to be the customer login Hannah, then rolls back:

```sql
begin;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
set local role authenticated;
select (select count(*) from items) as items_visible,
       (select count(*) from v_catalog) as catalog_visible,
       (select count(*) from gl_entries) as gl_visible,
       (select count(*) from sales_orders) as my_orders_visible,
       (select count(*) from customers) as customers_visible;
rollback;
```

**Expect:** `items_visible = 0`, `catalog_visible = 26`, `gl_visible = 0`, `my_orders_visible` = Hannah's orders only (≈ 20–30, not ≈ 270), and `customers_visible = 1`.

Change the `sub` to the cashier, `e0000000-0000-4000-8000-000000000003`, and the same query shows all **70** items, all orders and **14** customers, but still `gl_visible = 0`, because the GL is manager-only. With the manager (`…000000000002`) `gl_visible` is ≈ 42,000.

## Step 9 — Live reports recalculate

```sql
select fn_pnl(app.today(), app.today()) ->> 'net_sales' as todays_net_sales;
```
Run it, do Step 2 again, and run it again. **Expect:** it goes up by exactly **$50.65**, the new sale's net. Before 10 am Utah time the simulated store hasn't opened, so the starting value may be 0.

```sql
update settings set ordering_cost = 90 where id = 1;
select sku, eoq from fn_reorder_metrics() where sku in ('WAX-SOY','CND-EZRA');
```
Compare with `ordering_cost = 45`. **Expect:** EOQ rises by √2 ≈ 1.41× (e.g. WAX-SOY 860 → 1216 lb, CND-EZRA 363 → 513). Set it back afterwards with `update settings set ordering_cost = 45 where id = 1;`.

## Step 10 — Reset

Run `sql/04_seed.sql` again. **Expect:** it finishes in about 1–2 minutes and Step 1's counts are back. Everything you did in Steps 2–9 is gone.

---

### Pass criteria

All steps behave as described, and **snapshot** always shows `gl_out_of_balance = 0.00` and `ledger_mismatches = 0`.
