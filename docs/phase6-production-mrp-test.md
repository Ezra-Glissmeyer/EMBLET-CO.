# Phase 6 test script — production orders, production report, MRP

Hard-refresh first (Ctrl+Shift+R / Cmd+Shift+R). Sign in as **production@emblet.test** unless a step says manager. Run SQL in **Supabase → SQL Editor** (Run this query). The transactions are RPCs: `create_production_order`, `issue_production_order`, `complete_production_order`, `cancel_production_order`, `run_mrp`, plus `create_purchase_order` / `transfer_inventory` when converting or moving stock.

> Re-run `sql/04_seed.sql` if you seeded before Nov 17, so the 2 in-progress orders and the demo story are in place.

---

## A. Set the scene (so you can see the "move from warehouse" fix)
This parks all the glycerin soap base in the Warehouse, so the Workshop is short but the company isn't:
```sql
select transfer_inventory(id, 'WKS', 'WHS', app.on_hand(id, 'WKS')) from items where sku = 'SB-GLY' and app.on_hand(id, 'WKS') > 0;
```

## B. Create → materials → issue → complete → **Production**
1. **+ New production order** → Item **SOAP-BROOKE · Babbling Brooke**, Quantity `48`, Location **Workshop** → **Create order**.
   ```sql
   select mo_no, status, qty_planned, location_code, planned_start, planned_finish from production_orders order by id desc limit 1;   -- PLANNED | 48 | WKS
   ```
2. On that row click **Materials**. **Expect** a table: each component's per-unit qty, **Needed** (48 × BOM), At WKS, At WHS, **Short**.
   - SB-GLY (needs 12.96 lb) shows **short** with an amber "move … from WHS".
   - The other components show a green ✓.
3. Close it and click **Issue materials**.
   - **Expect:** the Materials window opens with a red "Not enough components at Workshop – Orem… Nothing was consumed."
   - No ledger rows were created:
   ```sql
   select count(*) from inventory_transactions where ref_no = (select mo_no from production_orders order by id desc limit 1);   -- 0
   ```
4. Click **Move & issue**. **Expect:** "Moved 1 component(s) from Warehouse… to Workshop…", then "MO-… issued — $… of materials moved to Work in Process (lot LOT-…)". The order is now **In Progress**.
   ```sql
   select txn_type, count(*), sum(qty) from inventory_transactions where ref_no = (select mo_no from production_orders order by id desc limit 1) group by 1;
   -- PROD_ISSUE | 5 rows (base, fragrance, colorant, wrap, label)
   select status, component_cost, lot_no, actual_start from production_orders order by id desc limit 1;   -- IN_PROGRESS | ≈ 76 | LOT-yymmdd-n
   select account_code, sum(debit) dr, sum(credit) cr from gl_entries where ref_type = 'PROD_ISSUE'
    and ref_no = (select mo_no from production_orders order by id desc limit 1) group by 1;
   -- 1250 Work in Process Dr = component_cost | 1200 Inventory–Raw Materials Cr (same total)
   ```
5. **Complete…**
   - Type Scrapped `5`: **Good jumps to 43**. Then type Good `44`: **Scrap jumps to 4**. Good + scrap always equals the 48 started.
   - Leave the scrap reason empty → **Complete & receive**. **Expect:** "Choose a scrap reason code…"
   - Pick **AIR_BUBBLES**. **Expect:** the blue preview reads "Unit cost = $76.xx ÷ 44 good = $1.74 · FPY 91.7%".
   - Actual start/finish are pre-filled. If you issued only moments ago, finish = start + the planned run time, so it's always after start.
   - **Complete & receive.** **Expect:** "MO-… complete: 44 good at $1.74 (std $1.59)". Actual is above standard because the 4 scrapped bars' materials are absorbed by the 44 good ones.
   ```sql
   select status, qty_started, qty_good, qty_scrap, scrap_reason, component_cost, actual_unit_cost, std_unit_cost
     from production_orders order by id desc limit 1;
   -- COMPLETED | 48 | 44 | 4 | AIR_BUBBLES | ≈76.47 | ≈1.738 (= 76.47 ÷ 44) | 1.593
   select qty, unit_cost, lot_no from inventory_transactions where txn_type = 'PROD_RECEIPT' order by id desc limit 1;   -- +44 at ≈1.738, same lot
   select account_code, debit, credit from gl_entries where ref_type = 'PROD_COMPLETE' order by id desc limit 2;
   -- 1210 Finished Goods Dr ≈76.47 | 1250 WIP Cr ≈76.47   (WIP is back to zero for this order)
   select lot_no, fragrance_lot, poured_on from lots order by id desc limit 1;
   ```

## C. A true shortage (the wet wicks)
On **MO-… CND-MALLOW (144)** click **Issue materials**. **Expect:** the Materials window shows **WCK-08 short ~84** with a red "not in stock — buy" (only 60 wicks exist anywhere). There's **no** "Move & issue" button, because the wicks have to be purchased. The note shows the most the order could make with all stock.

## D. Production report → **Production report** tab
Defaults to the last 90 days → **Run report**. **Expect:**
- **KPI tiles:** First-pass yield (≈ 96%), Scrap rate, Throughput (units/hr), Avg cycle time (hrs), On-time completion %, Cost variance ($ and %).
- **Charts:** a weekly good-vs-scrap bar chart with an FPY line, and a scrap-by-reason doughnut.
- **Tables:** scrap by reason (AIR_BUBBLES now includes your 4), plus a **By item** table with actual vs standard cost and variance %. Beehive Honey has the worst scrap (frosting, sinkholes).
```sql
select fn_production_metrics(current_date - 90, current_date) ->> 'first_pass_yield_pct' fpy,
       fn_production_metrics(current_date - 90, current_date) ->> 'units_good' good,
       fn_production_metrics(current_date - 90, current_date) ->> 'units_started' started;   -- fpy = good ÷ started × 100
```

## E. MRP grid → **MRP** (sign in as the **manager** for step 5)
1. The page runs MRP for **4 weeks, lot-for-lot** on load. **Expect** a **Planned orders** list followed by one time-phased record per item, each with an **On hand now** column and Weeks 1–4. The rows are:
   - Gross requirements
   - Scheduled receipts
   - Projected on hand
   - Net requirements
   - Planned order receipt (green)
   - Planned order release
   - Order-by date (red ⚠ if past)
2. **Netting by hand (Cabin Cocoa, level 1):** On hand now **72**. Week 1 gross = the Cabin Cocoa candles needed that week by sales orders and Cozy Cabin Kits. Check that projected on hand = previous + scheduled − gross + planned receipt, every week.
   ```sql
   select week_no, gross_req, sched_receipts, proj_on_hand, net_req, planned_receipt, release_date, past_due
     from mrp_lines where run_id = (select max(id) from mrp_runs) and item_id = (select id from items where sku = 'CND-COCOA') order by week_no;
   ```
3. **FO-COCOA (level 2)** is flagged red: "Release date already past!" Its planned order's order-by date is ~10 days before it's needed (10-day supplier lead time). Click **Pegging ⟶ which orders?** **Expect:** rows like `SO-… Main Street Mercantile · Cozy Cabin Kit → Cabin Cocoa → Fragrance Oil – Hot Chocolate & Peppermint · 28.8 oz`. That's the recursive explosion, gift set → candle → oil.
4. **Lot sizing:** switch to **EOQ lot sizing** → **Run MRP**. **Expect:** FO-COCOA's planned order becomes its EOQ (~400 oz) instead of the exact net amount.
   ```sql
   select r.lot_rule, l.net_req, l.planned_receipt from mrp_lines l join mrp_runs r on r.id = l.run_id
    where l.item_id = (select id from items where sku = 'FO-COCOA') and l.planned_receipt > 0 order by r.id desc limit 2;
   ```
   Switch back to Lot-for-lot.
5. **Convert to orders:**
   - **As production:** tick **CND-COCOA** (Make) and **FO-COCOA** (Buy) → **Convert selected**.
     - **Expect:** "Created MO-…", plus a note "Skipped FO-COCOA: only managers can create purchase orders".
   - **As the manager:** tick **FO-COCOA** → **Convert**. **Expect:** "Created PO-…".
   ```sql
   select mo_no, status, qty_planned, notes from production_orders order by id desc limit 1;   -- PLANNED | From MRP planned order
   select p.po_no, s.name, l.qty_ordered, p.status from purchase_orders p join suppliers s on s.id = p.supplier_id
     join po_lines l on l.po_id = p.id order by p.id desc limit 1;   -- Sage & Ember | FO-COCOA | ORDER_SENT
   ```
   MRP re-runs after converting. **Expect:** CND-COCOA now shows the new MO under **Scheduled receipts**, and its planned order for that week is gone or smaller. FO-COCOA shows the PO as a scheduled receipt. It may still be flagged late if the PO arrives after the oil is needed.

---
**Final check:** `select sum(debit) - sum(credit) from gl_entries;` → **0.00**. Re-run `sql/04_seed.sql` before the demo.
