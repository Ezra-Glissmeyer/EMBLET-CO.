# Phase 5 test script — suppliers, POs, A/P, ROP/EOQ, periodic review, scorecards

Sign in as **manager@emblet.test** and hard-refresh first (Ctrl+Shift+R / Cmd+Shift+R). Run SQL checks in **Supabase → SQL Editor** (Run this query). Every purchasing transaction is an RPC: `create_purchase_order`, `receive_purchase_order`, `close_purchase_order`, `record_supplier_payment`.

> Re-run `sql/04_seed.sql` first if you seeded before Nov 17. That update guarantees 2 production orders are in progress, whatever day you seed.

---

## A. Supplier CRUD → **Suppliers & Scorecard → Supplier directory**
1. **+ Add supplier:** Name `Wasatch Wick Works`, Contact `Sam Ortiz`, Email `not-an-email`, Lead time `6`, Terms **Net 15** → **Save**. **Expect:** "That email address doesn't look right." Fix the email to `sam@wasatchwick.example` → **Save** → "Supplier saved".
   ```sql
   select name, quoted_lead_days, payment_terms, active from suppliers where name = 'Wasatch Wick Works';   -- 6 | Net 15 | true
   ```
2. Open it. Under **Items supplied & cost**, add **WCK-04** at `0.11` → **Add**, then change the cost to `0.105`. **Expect:** "WCK-04: new POs to this supplier will default to $0.11". The cost is stored to 4 decimals, so the toast rounds it.
   ```sql
   select unit_cost from supplier_items where supplier_id = (select id from suppliers where name = 'Wasatch Wick Works');   -- 0.1050
   ```
3. **Delete** it → confirm. **Expect:** "Deleted". The suppliers row and its `supplier_items` row are both gone.
4. Open **Bonneville Wax Supply** → **Delete**. **Expect:** "Bonneville Wax Supply has purchase orders or items on file, so it can't be deleted… Untick Active instead." Nothing changes.
5. **Lead time drives ROP:** note WCK-08's ROP:
   ```sql
   select lead_time_days, rop from fn_reorder_metrics() where sku = 'WCK-08';   -- e.g. 5 | 191.30
   ```
   Open **Red Butte Wick & Accessories**, change Lead time 5 → `8` → **Save** → answer **Update items**. **Expect:** "10 item lead time(s) updated to 8 days". Re-run the query: **8 | higher ROP** (e.g. 282.90). Set it back to **5** the same way.

## B. PO: create → sent → partial receive → receive rest → close → **Purchasing**
1. **+ New purchase order** → Supplier **Bonneville Wax Supply (7 d, Net 30)**, Ship to **Workshop**. **Expect:** "Expected receipt: … (today + 7-day quoted lead time)".
2. Line **WAX-SOY**, qty `100`. **Expect:** unit cost pre-fills **2.10** from Bonneville's price list (Total $210.00). Change the unit cost to `2.30` so you'll see the weighted average move.
3. **Create & send PO.** **Expect:** "PO-… sent — expected <date>", and the printable **Purchase Order** opens (supplier, ship-to, expected date, terms, lines, total), with a **🖨 Print PO** button.
   ```sql
   select po_no, status, order_date, expected_date, expected_date - order_date as lead from purchase_orders order by id desc limit 1;   -- ORDER_SENT | … | 7
   select avg_cost, (select sum(qty) from inventory_balances where item_id = i.id) on_hand from items i where sku = 'WAX-SOY';   -- note both
   ```
4. **Scan to receive** tab → choose that PO. Receive **60** (type it in Receiving now; or scan `EMB10001` once per unit) → **Post receipt**.
   **Expect:** "RCV-… posted — 7 days early. PO is partially received; invoice AP-RCV-… created". The screen **stays on this PO** for the rest.
   ```sql
   select r.receipt_no, r.days_late, p.status from po_receipts r join purchase_orders p on p.id = r.po_id order by r.id desc limit 1;   -- −7 | PARTIALLY_RECEIVED
   select avg_cost from items where sku = 'WAX-SOY';
   -- = (old on_hand × old avg_cost + 60 × 2.30) ÷ (old on_hand + 60)   ← weighted average
   select invoice_no, amount, invoice_date, due_date from ap_invoices order by id desc limit 1;   -- 138.00 | today | today + 30 (Net 30)
   select account_code, debit, credit from gl_entries where ref_no = (select receipt_no from po_receipts order by id desc limit 1);
   -- 1200 Inventory–Raw Materials Dr 138.00 | 2000 Accounts Payable Cr 138.00
   ```
5. **All remaining** → **Post receipt**. **Expect:** "…PO is received…". Then **Purchase orders** tab → status filter **All statuses** → open the PO → **Close PO**. **Expect:** status **CLOSED**.
6. The **Purchase orders** list now opens on **Open** POs, with status and supplier filters and a "past expected date" count.

## C. A/P invoices & payments → **Purchasing → A/P invoices & payments**
1. Make a PO to **Sage & Ember (2/10 Net 30)** for **FO-PINE** qty `32` ($56.00) and receive all of it.
   ```sql
   select invoice_no, amount, discount_pct, discount_date, due_date from ap_invoices order by id desc limit 1;   -- 56.00 | 2 | today+10 | today+30
   ```
2. On that invoice click **Pay…**. **Expect:** "2/10 Net 30: pay in full by <date> and save $1.12". The amount is **54.88** and "Take the early-payment discount" is ticked. **Record payment** → "paid in full (saved $1.12)".
   ```sql
   select amount, discount_taken from ap_payments order by id desc limit 1;   -- 54.88 | 1.12
   select account_code, debit, credit from gl_entries where ref_type = 'AP_PAYMENT' order by id desc limit 3;
   -- 2000 A/P Dr 56.00 | 1000 Cash Cr 54.88 | 7000 Purchase Discounts Earned Cr 1.12
   ```
3. **Partial payment:** on any other open Net-terms invoice click **Pay…** → Amount `10` → **Record payment**. **Expect:** "$10.00 paid · $… still open". The invoice stays **Open** with `amount_paid` up by 10.
4. Past-due invoices show a red "Past due N d" badge. Great Basin and Beehive Label have some.

## D. ROP / EOQ / safety stock → **Reorder Review**
1. Find **WAX-SOY** and click **Show math**. **Expect** four formula blocks with the real numbers:
   - Average daily usage d, exploded through the BOMs of everything sold.
   - Safety stock = z × σd × √L.
   - ROP = d × L + SS.
   - EOQ = √(2DS / H), where H = 25% × unit cost.

   Check one EOQ yourself: √(2 × annual demand × 45 ÷ (0.25 × unit cost)).
2. **Ordering rules** panel: set Holding cost to `0` → **Save & recalculate**. **Expect:** "Holding cost must be more than 0%…" and nothing saved.
3. Set Holding back to `25`, Ordering cost to `90` → **Save & recalculate**. **Expect:** every EOQ rises **×1.414 (√2)**, e.g. WAX-SOY ≈ 909 → ≈ 1,285.
   ```sql
   select ordering_cost from settings;                                   -- 90.00
   select sku, eoq from fn_reorder_metrics() where sku = 'WAX-SOY';      -- the new EOQ
   ```
   Put it back to **45**.

## E. Periodic review → one-click POs / production orders
1. Filter: **Needs action**. **Expect:**
   - **FO-COCOA, BOX-LG, WCK-08** are red **Below ROP**.
   - Other rows are amber **Review soon**, meaning they'll cross their ROP within the 7-day review period.
   - Each row shows on hand, on order, ROP, EOQ, the **Suggested** qty and an **Order by** date (red if today or earlier).
2. Tick **FO-COCOA, BOX-LG, WCK-08** → **🚚 Create POs (grouped by supplier)**. **Expect:** "Created PO-…, PO-…, PO-… (Order Sent)". That's **one PO per supplier**: Sage & Ember, Beehive Label & Box, Red Butte Wick.
   ```sql
   select p.po_no, s.name, i.sku, l.qty_ordered from purchase_orders p join suppliers s on s.id = p.supplier_id
    join po_lines l on l.po_id = p.id join items i on i.id = l.item_id order by p.id desc limit 3;
   select sku, status, on_order from fn_reorder_metrics() where sku = 'FO-COCOA';   -- no longer BELOW_ROP; on_order > 0
   ```
3. Tick a **made** item (e.g. SOAP-LIZ) → **🕯️ Create production orders**. **Expect:** "Created MO-…" (see Production).

## F. Supplier scorecard → **Suppliers & Scorecard**
1. **Expect** a callout explaining **40% on-time + 30% fill rate + 30% lead-time accuracy**, with the thresholds **Keep ≥ 90 / Watch 75–90 / Replace < 75** (editable in Settings).
2. **Expect:**
   - **Bonneville = Keep** (near 100% on time and complete).
   - **Sage & Ember = Watch** (often late).
   - **Great Basin Glass & Tin = Replace** (short-ships and is late, with past-due invoices).

   Each row shows on-time %, actual vs quoted lead time, fill %, open invoices / amount owed / next due, and past-due badges. A chart compares actual vs quoted lead time.
3. Check the math for one supplier:
   ```sql
   select name, on_time_pct, fill_rate_pct, lead_accuracy_pct, overall_score, rating from v_supplier_scorecard order by overall_score desc;
   -- overall_score = 0.4 × on_time_pct + 0.3 × fill_rate_pct + 0.3 × lead_accuracy_pct
   ```
4. Your early, complete Bonneville receipt from B counts toward its on-time and fill rate: the score stays **Keep**.

---
**Final check:** `select sum(debit) - sum(credit) from gl_entries;` → **0.00**. Re-run `sql/04_seed.sql` before the demo.
