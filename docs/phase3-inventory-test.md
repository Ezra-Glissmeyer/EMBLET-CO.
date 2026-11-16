# Phase 3 test script — item master, BOMs, inventory, ledger, labels, scanner

Sign in on the live site as **manager@emblet.test**. Keep **Supabase → Table Editor** open in another tab. To check a step's database rows, paste the SQL shown into the **SQL Editor** (Run this query).

Before starting, **hard-refresh** the site (Ctrl+Shift+R / Cmd+Shift+R) so you have the newest version.

---

## A. Item master — create a raw material
1. **Items & BOMs → + New item.**
2. Fill in: Type **Raw material**, Category **Fragrance oil**, UoM **oz**, SKU `FO-ALPINE`, Name `Fragrance Oil – Alpine Meadow`, Standard / purchase cost `2.00`, Preferred supplier **Sage & Ember Fragrance House**.
   - **Expect:** the **Barcode** box is already filled in with the next free raw-material code (e.g. `EMB10096`), and Lead time changes to **10** (that supplier's quoted lead time).
3. Click **Create item**. **Expect:** a toast "Created FO-ALPINE (barcode EMB1…)", and the item appears on the **Raw materials** tab.

**Rows that change:**
```sql
select sku, item_type, uom, barcode, std_cost, avg_cost, lead_time_days, ordering_policy from items where sku = 'FO-ALPINE';
select * from supplier_items where item_id = (select id from items where sku = 'FO-ALPINE');
```
**Expect:** 1 new `items` row (cost 2.0000, lead 10, policy MRP) and 1 new `supplier_items` row for supplier 2 at 2.0000.

## B. Create a finished good and build its BOM
1. **+ New item** → Type **Finished good**, Category **8 oz candle**, SKU `CND-ALPINE`, Name `Alpine Meadow`. Leave the price empty and click **Create item**.
   - **Expect:** a red toast saying sellable items need a selling price. Nothing is created.
2. Enter Selling price `25` and Scent notes `Wildflowers & pine`, then **Create item**.
   - **Expect:** the item window opens with a yellow "No BOM yet" warning, and the product mock-up shows a candle in your chosen colour.
3. Add these components one at a time (pick in the dropdown → type the qty → **Add component**):

   | Component | Qty |
   |---|---|
   | WAX-SOY | 0.45 |
   | WCK-08 | 1 |
   | FO-ALPINE | 0.6 |
   | JAR-08 | 1 |
   | LID-08 | 1 |
   | LBL-CND | 1 |

   - **Expect:** after the last one, "Rolled-up standard cost: **$4.30**" (0.45 × 2.10 + 0.18 + 0.6 × 2.00 + 1.35 + 0.40 + 0.22 = 4.295).
4. **Edit in place:** change FO-ALPINE's qty from 0.6 to `0.8` and press Tab. **Expect:** the standard cost becomes **$4.70**.

**Rows that change:**
```sql
select c.sku, b.qty_per from bom_lines b join items c on c.id = b.component_id
 where b.parent_id = (select id from items where sku = 'CND-ALPINE') order by b.id;
select sku, std_cost from items where sku = 'CND-ALPINE';
```
**Expect:** 6 `bom_lines` rows (FO-ALPINE = 0.8000), and `std_cost` = **4.6950**.

## C. BOM loop guard
1. Open **CND-EZRA (Ezra's Embers)** → add component **KIT-HOLIDAY**, qty 1.
2. **Expect:** a red toast "KIT-HOLIDAY already contains CND-EZRA in its own BOM… would create a loop". Ezra still has **7** components:
```sql
select count(*) from bom_lines where parent_id = (select id from items where sku = 'CND-EZRA');   -- 7
```

## D. A cost change flows up the BOM
1. **Raw materials** tab → **FO-ALPINE** → **✎ Edit item** → change the cost from 2.00 to `2.50` → **Save changes**.
2. **Expect:** a toast "Standard cost of 1 made item(s) updated…".
```sql
select sku, std_cost from items where sku in ('FO-ALPINE','CND-ALPINE');   -- 2.5000 and 5.0950
```

## E. Transfer (scan with a USB scanner, or type + Enter)
1. Run this first to note the starting quantities:
```sql
select location_code, qty from inventory_balances where item_id = (select id from items where sku = 'CND-EZRA') order by 1;
```
2. **Inventory → Transfer.** In **Scan item**, type `EMB20001` and press **Enter** (a USB scanner does exactly this). **Expect:** the On hand line shows Ezra's Embers at each location.
3. From **Workshop**, To **Storefront**, Quantity `5` → **Post transfer**. **Expect:** a toast "TR-…: moved 5 ea of Ezra's Embers WKS → STR".
   - If the Workshop has fewer than 5, transfer from Storefront to Workshop instead.
4. Re-run the query. **Expect:** WKS −5, STR +5. Two new ledger rows and **no** GL rows, because both locations are the same Inventory account:
```sql
select txn_type, location_code, qty, ref_no from inventory_transactions order by id desc limit 2;   -- TRANSFER_IN +5, TRANSFER_OUT −5
```
5. Try From **Workshop** → To **Workshop**. **Expect:** "From and To locations must be different."

## F. Adjustment with a reason code (posts to the GL)
1. **Adjust** tab. Scan / type `EMB10041` (8 oz amber jars) → Location **Workshop**, Direction **Remove (−)**, Quantity `2`.
2. Click **Post adjustment** without choosing a reason. **Expect:** "A reason code is required."
3. Choose **DAMAGED — Damaged in handling** → **Post adjustment**. **Expect:** "ADJ-… posted. New on hand at WKS: …".
```sql
select txn_type, qty, reason_code, ref_no from inventory_transactions order by id desc limit 1;      -- ADJUSTMENT, −2, DAMAGED
select account_code, debit, credit from gl_entries where ref_no = (select ref_no from inventory_transactions order by id desc limit 1);
-- 5100 Scrap/Write-off debit 2.70  |  1200 Inventory – Raw Materials credit 2.70   (2 × $1.35)
```

## G. Cycle count (blind)
1. **Cycle count** tab → Counting at **Storefront**. Scan / type `EMB20001`.
   - **Expect:** "Blind count — system quantity hidden until you post."
2. Look up the real number:
```sql
select qty from inventory_balances where item_id = (select id from items where sku = 'CND-EZRA') and location_code = 'STR';
```
3. Enter that number **minus 1** → **Post count**.
   - **Expect:** a toast "Variance -1 posted (ADJ-…)", and the session table shows System / Counted / Variance −1 / Value.
```sql
select txn_type, qty, reason_code from inventory_transactions order by id desc limit 1;   -- CYCLE_COUNT, −1, CYCLE_COUNT
```
4. Enter the exact quantity on a second item. **Expect:** "Count matches the system ✔", and **no** new ledger row.

## H. Item ledger
1. **Item history (ledger)** tab → scan `EMB20001`.
2. **Expect:** every movement newest first: CYCLE COUNT −1, TRANSFER IN +5, plus the history (SALE, PROD RECEIPT, RETURN…), each with a running total. The badges at the top show the per-location totals, and they match the On hand grid.
3. From **Items & BOMs**, opening an item and clicking **Item ledger →** jumps straight here, and the item window closes.

## I. On-hand grid filters
**On hand by location** tab:
- **Location = QA Hold** shows Cabin Cocoa (the held pour).
- Tick **Below ROP / review only**: FO-COCOA, BOX-LG and WCK-08 appear, highlighted red.
- Type a SKU in the search box to filter.
- Click any row to open that item's ledger.

## J. Barcode labels
1. **Barcode Labels** → Show **Finished goods** → **1 of each**.
   - **Expect:** a 3-column sheet preview, one label per finished good (Alpine Meadow included), each with name, Code 128 barcode, SKU and price.
2. **🖨 Print labels** opens the print dialog. Print at **100% / Actual size, margins None** on letter paper, or Save as PDF to check.

## K. Camera scanner (phone + laptop)
1. Print one sheet from J, or show a label on another screen.
2. **Laptop webcam:** sign in as the cashier → **Point of Sale** → **📷 Camera** → allow camera access → hold a label 6–10 inches from the camera. **Expect:** a beep, and the item is added to the cart. In continuous mode the window stays open for the next scan.
3. **Phone:** open the site on your phone, sign in as the cashier, tap **📷 Camera** (the back camera opens) and scan a label. **Expect:** the same result. On the phone the keyboard does **not** pop up automatically.
4. **USB scanner:** click the scan box and scan. **Expect:** it types the code + Enter and adds the item.

## Clean up
Run `sql/04_seed.sql` again to remove the test items and movements before your demo.

**Pass:** every Expect above, especially the row changes in A, B, D, E, F and G, and the GL lines in F.
