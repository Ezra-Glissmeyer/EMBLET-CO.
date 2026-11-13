-- =====================================================================
-- Emblet Co. Mini-ERP  |  04_seed.sql   (re-runnable)
-- Wipes all Emblet data and rebuilds it. All dates are RELATIVE to
-- today (America/Denver), so the data never goes stale.
--
-- History (~14 months) is produced by a day-by-day simulation that posts
-- EVERY sale, receipt, production run, transfer, return and payment
-- through the SAME internal functions the live app uses (app._post_sale,
-- app._receive_po, app._issue_mo ...). So the ledger, GL, weighted-average
-- costs, P&L, turnover, ROP and EOQ are all consistent with history.
-- Expect it to take roughly 30-90 seconds in the Supabase SQL editor.
-- =====================================================================

set statement_timeout = 0;
select setseed(0.4242);

-- ---------- 0. wipe ----------
truncate mrp_pegging, mrp_lines, mrp_runs, ar_payments, ar_invoices, ap_payments, ap_invoices,
         receipt_lines, po_receipts, po_lines, purchase_orders, exchanges, return_lines, returns, payments,
         sale_lines, sales, so_lines, sales_orders, production_orders, lots,
         inventory_transactions, inventory_balances, gl_entries, gl_accounts,
         supplier_items, bom_lines, items, suppliers, customers, reason_codes, profiles, locations, settings, doc_counters
         restart identity cascade;
alter sequence gl_journal_seq restart with 1;
delete from auth.users where email like '%@emblet.test';

drop schema if exists seed cascade;
create schema seed;

-- ---------- 1. settings, locations, reason codes, chart of accounts ----------
insert into settings(id) values (1);

insert into locations(code, name, purpose, sellable, sort) values
 ('WKS','Workshop – Orem','Production; most raw materials and fresh finished goods', true, 1),
 ('WHS','Warehouse – Springville','Bulk raw materials, overflow finished goods, wholesale picking', true, 2),
 ('STR','Storefront – Provo','Retail POS and customer pickup (finished goods only)', true, 3),
 ('QAH','QA Hold','Returned or defective goods awaiting inspection — not sellable', false, 4);

insert into reason_codes(code, category, description, is_quality, gl_account) values
 ('CYCLE_COUNT','ADJUST','Cycle count variance', false, '5200'),
 ('DAMAGED','ADJUST','Damaged in handling', false, '5100'),
 ('EXPIRED_FRAGRANCE','ADJUST','Fragrance oil expired / went cloudy', false, '5100'),
 ('SAMPLE_USE','ADJUST','Used as a tester or sample', false, '5200'),
 ('FOUND','ADJUST','Found stock', false, '5200'),
 ('QA_SCRAP','ADJUST','Failed QA inspection — scrapped', true, '5100'),
 ('CHANGED_MIND','RETURN','Customer changed mind', false, null),
 ('WRONG_SCENT','RETURN','Wrong scent / not as expected', false, null),
 ('TUNNELING','RETURN','Candle tunneling', true, null),
 ('WICK_DROWNED','RETURN','Wick drowned', true, null),
 ('CRACKED_JAR','RETURN','Cracked jar', true, null),
 ('WEAK_SCENT_THROW','RETURN','Weak scent throw', true, null),
 ('SOAP_SWEATING','RETURN','Soap sweating (glycerin dew)', true, null),
 ('DAMAGED_IN_TRANSIT','RETURN','Damaged in transit', true, null),
 ('FROSTING','SCRAP','Frosting on wax surface', true, null),
 ('WET_SPOTS','SCRAP','Wet spots (wax pulled from glass)', true, null),
 ('SINKHOLE','SCRAP','Sinkhole around wick', true, null),
 ('WICK_OFF_CENTER','SCRAP','Wick off center', true, null),
 ('LABEL_MISPRINT','SCRAP','Label misprint / misapplied', true, null),
 ('AIR_BUBBLES','SCRAP','Air bubbles in soap', true, null),
 ('SEPARATION','SCRAP','Additive / layer separation', true, null);

insert into gl_accounts(code, name, acct_type, sort) values
 ('1000','Cash','asset',10), ('1100','Accounts Receivable','asset',20),
 ('1200','Inventory – Raw Materials','asset',30), ('1210','Inventory – Finished Goods','asset',40),
 ('1250','Work in Process','asset',45),
 ('2000','Accounts Payable','liability',50), ('2100','Sales Tax Payable','liability',60),
 ('3000','Owner''s Equity','equity',70),
 ('4000','Sales Revenue','revenue',80), ('4100','Sales Discounts','contra_revenue',90),
 ('4200','Sales Returns & Allowances','contra_revenue',100),
 ('5000','Cost of Goods Sold','expense',110), ('5100','Scrap / Inventory Write-off Expense','expense',120),
 ('5200','Inventory Adjustment','expense',130),
 ('6000','Wages & Salaries','expense',140), ('6100','Rent – 3 locations','expense',150),
 ('6200','Utilities','expense',160), ('6300','Marketing','expense',170), ('6400','Card Processing Fees','expense',180),
 ('7000','Purchase Discounts Earned','other_income',190);

-- ---------- 2. suppliers ----------
insert into suppliers(id, name, contact_name, email, phone, address, quoted_lead_days, payment_terms, notes) values
 (1,'Bonneville Wax Supply','Dana Whitlock','orders@bonnevillewax.example','(801) 555-0181','1420 S 300 W, Salt Lake City, UT 84115',7,'Net 30','Soy and beeswax. Ships complete, on time.'),
 (2,'Sage & Ember Fragrance House','Marcus Reyes','sales@sageember.example','(801) 555-0127','2280 Wall Ave, Ogden, UT 84401',10,'2/10 Net 30','All fragrance oils. Great oils, slow dock.'),
 (3,'Great Basin Glass & Tin','Priya Natarajan','po@greatbasinglass.example','(208) 555-0164','5150 W Chinden Blvd, Boise, ID 83714',14,'Net 45','Amber jars, lids, tins. Frequently short-ships.'),
 (4,'Uinta Soap Base Co.','Kelsey Morgan','hello@uintasoap.example','(435) 555-0119','95 N Main St, Logan, UT 84321',7,'Net 30','Melt-and-pour bases, colorants, botanicals.'),
 (5,'Beehive Label & Box','Trevor Allred','print@beehivelabel.example','(801) 555-0133','650 E State St, American Fork, UT 84003',10,'Net 15','Labels, soap wraps, gift boxes.'),
 (6,'Red Butte Wick & Accessories','Jenna Owens','jenna@redbuttewick.example','(435) 555-0102','1730 E Red Hills Pkwy, St. George, UT 84770',5,'Net 30','Wicks, dye chips, trimmers, soap dishes, crinkle fill.');
select setval('suppliers_id_seq', 6);

-- ---------- 3. items ----------
-- raw materials & resale  (sku, name, category, uom, cost, supplier, barcode, price)
insert into items(sku, name, item_type, category, uom, std_cost, avg_cost, preferred_supplier_id, lead_time_days, barcode, price, ordering_policy, description, color_hex)
select v.sku, v.name, v.t, v.cat, v.uom, v.cost, v.cost, v.sup, s.quoted_lead_days, v.bc, v.price,
       case when v.t = 'raw' then 'MRP' else 'ROP_EOQ' end, v.descr, v.col
from (values
 ('WAX-SOY','Soy Wax (464 blend)','raw','wax','lb',2.10,1,'EMB10001',null::numeric,'Golden soy container wax, 50 lb cases','#EFE3C8'),
 ('WAX-BEE','Beeswax Blend','raw','wax','lb',6.80,1,'EMB10002',null,'Beeswax / coconut blend for Beehive Honey','#E2B44C'),
 ('WCK-08','Cotton Wick – 8 oz size','raw','wick','ea',0.18,6,'EMB10003',null,'Pre-tabbed CD-12 cotton wick','#F5EBDD'),
 ('WCK-04','Cotton Wick – 4 oz size','raw','wick','ea',0.12,6,'EMB10004',null,'Pre-tabbed CD-6 cotton wick','#F5EBDD'),
 ('FO-CEDAR','Fragrance Oil – Smoked Cedar & Campfire','raw','fragrance','oz',1.85,2,'EMB10011',null,'Phthalate-free fragrance oil','#8B5A3C'),
 ('FO-MALLOW','Fragrance Oil – Toasted Marshmallow & Brown Sugar','raw','fragrance','oz',1.95,2,'EMB10012',null,'Phthalate-free fragrance oil','#E8C9A0'),
 ('FO-PINE','Fragrance Oil – Pine, Fir & Cold Air','raw','fragrance','oz',1.75,2,'EMB10013',null,'Phthalate-free fragrance oil','#4F6B4A'),
 ('FO-TROPIC','Fragrance Oil – Citrus, Berry & Mango','raw','fragrance','oz',1.80,2,'EMB10014',null,'Phthalate-free fragrance oil','#E9895B'),
 ('FO-BLOSSOM','Fragrance Oil – Orange Blossom & Honey','raw','fragrance','oz',2.05,2,'EMB10015',null,'Phthalate-free fragrance oil','#F2B66D'),
 ('FO-RAIN','Fragrance Oil – Wet Stone, Sage & Rain','raw','fragrance','oz',2.10,2,'EMB10016',null,'Phthalate-free fragrance oil','#7D93A3'),
 ('FO-HONEY','Fragrance Oil – Honey & Vanilla','raw','fragrance','oz',1.90,2,'EMB10017',null,'Phthalate-free fragrance oil','#D9A441'),
 ('FO-COCOA','Fragrance Oil – Hot Chocolate & Peppermint','raw','fragrance','oz',1.95,2,'EMB10018',null,'Phthalate-free fragrance oil','#6B4430'),
 ('FO-LAV','Fragrance Oil – Lavender & Vanilla','raw','fragrance','oz',2.20,2,'EMB10019',null,'Skin-safe fragrance oil','#A58FC4'),
 ('FO-EUCA','Fragrance Oil – Eucalyptus & Spearmint','raw','fragrance','oz',1.70,2,'EMB10020',null,'Skin-safe fragrance oil','#8FC1B0'),
 ('FO-OAT','Fragrance Oil – Oatmeal, Milk & Honey','raw','fragrance','oz',1.80,2,'EMB10021',null,'Skin-safe fragrance oil','#E3D3B5'),
 ('FO-SANDAL','Fragrance Oil – Rose & Sandalwood','raw','fragrance','oz',2.40,2,'EMB10022',null,'Skin-safe fragrance oil','#C27C62'),
 ('FO-COCOMINT','Fragrance Oil – Coconut & Cool Mint','raw','fragrance','oz',1.85,2,'EMB10023',null,'Skin-safe fragrance oil','#DCE8EE'),
 ('FO-LEMON','Fragrance Oil – Lemon & Poppy','raw','fragrance','oz',1.65,2,'EMB10024',null,'Skin-safe fragrance oil','#F1DB6B'),
 ('DYE-RUST','Candle Dye Chips – Russet','raw','dye','oz',0.90,6,'EMB10031',null,'Concentrated dye chips','#8B4A2B'),
 ('DYE-GRN','Candle Dye Chips – Forest Green','raw','dye','oz',0.90,6,'EMB10032',null,'Concentrated dye chips','#3F5E3A'),
 ('DYE-ORG','Candle Dye Chips – Sunset Orange','raw','dye','oz',0.90,6,'EMB10033',null,'Concentrated dye chips','#E07B39'),
 ('DYE-BLU','Candle Dye Chips – Slate Blue','raw','dye','oz',0.90,6,'EMB10034',null,'Concentrated dye chips','#5D7489'),
 ('DYE-GLD','Candle Dye Chips – Honey Gold','raw','dye','oz',0.90,6,'EMB10035',null,'Concentrated dye chips','#D4A02F'),
 ('JAR-08','8 oz Amber Jar','raw','container','ea',1.35,3,'EMB10041',null,'Amber glass straight-side jar','#9A5B1F'),
 ('LID-08','Jar Lid – Brushed Gold','raw','container','ea',0.40,3,'EMB10042',null,'70-400 metal lid','#C8A27A'),
 ('TIN-04','4 oz Tin with Lid','raw','container','ea',0.85,3,'EMB10043',null,'Silver travel tin with lid','#B9B9B9'),
 ('LBL-CND','Candle Label – 8 oz','raw','label','ea',0.22,5,'EMB10051',null,'Kraft wrap-around label','#C8A27A'),
 ('LBL-MINI','Mini Tin Label','raw','label','ea',0.14,5,'EMB10052',null,'Round lid label','#C8A27A'),
 ('SB-GLY','Glycerin Soap Base','raw','soap_base','lb',3.80,4,'EMB10061',null,'Clear melt-and-pour base','#F3EEDC'),
 ('SB-GOAT','Goat Milk Soap Base','raw','soap_base','lb',4.60,4,'EMB10062',null,'Creamy goat milk melt-and-pour base','#F7F1E3'),
 ('SB-SHEA','Shea Butter Soap Base','raw','soap_base','lb',4.90,4,'EMB10063',null,'Shea butter melt-and-pour base','#F1E6CF'),
 ('COL-PUR','Soap Colorant – Purple','raw','colorant','oz',1.20,4,'EMB10071',null,'Skin-safe mica colorant','#7E5BA6'),
 ('COL-GRN','Soap Colorant – Mint Green','raw','colorant','oz',1.20,4,'EMB10072',null,'Skin-safe mica colorant','#6FB59A'),
 ('COL-YEL','Soap Colorant – Sunshine Yellow','raw','colorant','oz',1.20,4,'EMB10073',null,'Skin-safe mica colorant','#E8C547'),
 ('COL-BLU','Soap Colorant – Sky Blue','raw','colorant','oz',1.20,4,'EMB10074',null,'Skin-safe mica colorant','#8DB6D3'),
 ('COL-TER','Soap Colorant – Terracotta','raw','colorant','oz',1.20,4,'EMB10075',null,'Skin-safe mica colorant','#B8634A'),
 ('ADD-OAT','Ground Oatmeal','raw','additive','oz',0.25,4,'EMB10081',null,'Colloidal oatmeal','#D9C9A3'),
 ('ADD-CLAY','Rose Clay','raw','additive','oz',0.60,4,'EMB10082',null,'French rose clay','#D79A8A'),
 ('ADD-POPPY','Poppy Seeds','raw','additive','oz',0.45,4,'EMB10083',null,'Blue poppy seeds (exfoliant)','#3C4048'),
 ('WRP-SOAP','Soap Wrap – Kraft Band','raw','packaging','ea',0.18,5,'EMB10091',null,'Printed kraft belly band','#C8A27A'),
 ('LBL-SOAP','Soap Label','raw','label','ea',0.12,5,'EMB10092',null,'Ingredient sticker','#C8A27A'),
 ('BOX-SM','Small Gift Box','raw','packaging','ea',1.65,5,'EMB10093',null,'Kraft gift box with window','#B08A5E'),
 ('BOX-LG','Large Gift Box','raw','packaging','ea',2.75,5,'EMB10094',null,'Rigid two-piece gift box','#8A6A47'),
 ('FILL-CRK','Crinkle-Paper Fill','raw','packaging','oz',0.30,6,'EMB10095',null,'Natural kraft crinkle paper','#C8A27A'),
 ('ACC-TRIM','Wick Trimmer','resale','accessory','ea',4.25,6,'EMB60001',12.00,'Matte black wick trimmer — keeps flames clean and soot-free.','#2F2F2F'),
 ('ACC-DISH','Ceramic Soap Dish','resale','accessory','ea',5.50,6,'EMB60002',16.00,'Hand-glazed draining soap dish in juniper green.','#7E9A7A')
) v(sku, name, t, cat, uom, cost, sup, bc, price, descr, col)
join suppliers s on s.id = v.sup;

-- finished goods & kits (sku, name, category, family, notes, price, lead days, batch, color, accent, barcode, description)
insert into items(sku, name, item_type, category, scent_family, scent_notes, uom, price, lead_time_days, batch_size,
                  color_hex, accent_hex, barcode, description, ordering_policy)
select v.sku, v.name, case when v.cat = 'gift_set' then 'kit' else 'finished' end, v.cat, v.fam, v.notes, 'ea', v.price,
       v.lt, v.batch, v.col, v.acc, v.bc, v.descr, 'ROP_EOQ'
from (values
 ('CND-EZRA','Ezra''s Embers','candle_8oz','woodsy','Smoked cedar & campfire',24.00,2,144,'#8B5A3C','#3F2A1E','EMB20001','Like the last log on a Uinta campfire — smoky cedar, crackling ember, starry sky.'),
 ('CND-MALLOW','Mallow Mal','candle_8oz','sweet','Toasted marshmallow & brown sugar',24.00,2,144,'#E8C9A0','#A0673A','EMB20002','Golden-brown marshmallow on a stick, a little brown sugar, and zero sticky fingers.'),
 ('CND-ETHAN','Ethan''s Evergreen','candle_8oz','woodsy','Pine, fir & cold air',24.00,2,144,'#4F6B4A','#2C3E2A','EMB20003','A snowy trail above Sundance — fresh-cut fir, pine needles, and crisp mountain air.'),
 ('CND-TIEDYE','Tie-Dye Ty','candle_8oz','citrus','Citrus, berry & mango',24.00,2,144,'#E9895B','#B9466B','EMB20004','A summer road trip in a jar: juicy citrus, wild berry, and ripe mango.'),
 ('CND-TIMP','Timp Sunrise','candle_8oz','citrus','Orange blossom & honey',25.00,2,144,'#F2B66D','#C9772E','EMB20005','First light on Mount Timpanogos — orange blossom, warm honey, a hint of alpine bloom.'),
 ('CND-CANYON','Canyon Rain','candle_8oz','fresh','Wet stone, sage & rain',25.00,2,144,'#7D93A3','#4A5D6B','EMB20006','A spring storm rolling through the canyon: wet sandstone, desert sage, petrichor.'),
 ('CND-BEEHIVE','Beehive Honey','candle_8oz','sweet','Honey & vanilla',28.00,2,144,'#D9A441','#8A5E14','EMB20007','Poured in our beeswax blend — warm honey and vanilla bean for the Beehive State.'),
 ('CND-COCOA','Cabin Cocoa','candle_8oz','sweet','Hot chocolate & peppermint',26.00,2,144,'#6B4430','#B5333A','EMB20008','Cocoa by the cabin fire with a candy-cane stir. Our holiday best-seller.'),
 ('SOAP-LIZ','Liz''s Lavender','soap','floral','Lavender & vanilla',8.00,2,144,'#A58FC4','#6E5596','EMB30001','Calming lavender and soft vanilla in a clear glycerin bar.'),
 ('SOAP-BROOKE','Babbling Brooke','soap','fresh','Eucalyptus & spearmint',8.00,2,144,'#8FC1B0','#4E8C78','EMB30002','A cool mountain stream — eucalyptus and spearmint that wake you right up.'),
 ('SOAP-OAT','Oatmeal Hearth','soap','sweet','Oatmeal, milk & honey',8.50,2,144,'#E3D3B5','#A88B5A','EMB30003','Goat milk base with ground oatmeal — gentle, creamy, cozy as a hearth.'),
 ('SOAP-REDROCK','Red Rock Clay','soap','woodsy','Rose clay & sandalwood',9.00,2,144,'#C27C62','#8C4A35','EMB30004','Southern Utah red rock in a bar: French rose clay and sandalwood on shea butter.'),
 ('SOAP-WASATCH','Wasatch Snow','soap','fresh','Coconut & cool mint',8.50,2,144,'#DCE8EE','#7FA5BC','EMB30005','Fresh powder on the Wasatch — creamy coconut with a cool mint finish.'),
 ('SOAP-LEMON','Lemon Lather','soap','citrus','Lemon & poppy seed',8.00,2,144,'#F1DB6B','#B89A1E','EMB30006','Bright lemon with poppy-seed scrub — sunshine for your sink.'),
 ('MINI-EZRA','Ezra''s Embers Mini Tin','mini_tin','woodsy','Smoked cedar & campfire',11.00,2,96,'#8B5A3C','#3F2A1E','EMB40001','4 oz travel tin of Ezra''s Embers.'),
 ('MINI-MALLOW','Mallow Mal Mini Tin','mini_tin','sweet','Toasted marshmallow & brown sugar',11.00,2,96,'#E8C9A0','#A0673A','EMB40002','4 oz travel tin of Mallow Mal.'),
 ('MINI-ETHAN','Ethan''s Evergreen Mini Tin','mini_tin','woodsy','Pine, fir & cold air',11.00,2,96,'#4F6B4A','#2C3E2A','EMB40003','4 oz travel tin of Ethan''s Evergreen.'),
 ('MINI-TIEDYE','Tie-Dye Ty Mini Tin','mini_tin','citrus','Citrus, berry & mango',11.00,2,96,'#E9895B','#B9466B','EMB40004','4 oz travel tin of Tie-Dye Ty.'),
 ('MINI-LIZ','Liz''s Lavender Mini Tin','mini_tin','floral','Lavender & vanilla',11.00,2,96,'#A58FC4','#6E5596','EMB40005','Our lavender soap scent, now as a 4 oz candle.'),
 ('MINI-BROOKE','Babbling Brooke Mini Tin','mini_tin','fresh','Eucalyptus & spearmint',11.00,2,96,'#8FC1B0','#4E8C78','EMB40006','Our eucalyptus soap scent, now as a 4 oz candle.'),
 ('KIT-SAMPLER','The Six Wick Sampler','gift_set','sampler','All six teammate scents',59.00,1,36,'#C8A27A','#9CAF88','EMB50001','Six 4 oz tins — Ezra, Mal, Ethan, Ty, Liz and Brooke — nestled in crinkle paper.'),
 ('KIT-COZY','Cozy Cabin Kit','gift_set','sweet','Cabin Cocoa + Oatmeal Hearth',42.00,1,24,'#6B4430','#E3D3B5','EMB50002','Cabin Cocoa candle, Oatmeal Hearth soap and a wick trimmer in a gift box.'),
 ('KIT-FRESH','Fresh Start Set','gift_set','fresh','Canyon Rain + Babbling Brooke',44.00,1,24,'#7D93A3','#8FC1B0','EMB50003','Canyon Rain candle, Babbling Brooke soap and a ceramic soap dish.'),
 ('KIT-HOLIDAY','Holiday Hearth Box','gift_set','woodsy','Ezra + Ethan + Mal',64.00,1,24,'#4F6B4A','#8B5A3C','EMB50004','Three 8 oz candles for the season: Ezra''s Embers, Ethan''s Evergreen, Mallow Mal.')
) v(sku, name, cat, fam, notes, price, lt, batch, col, acc, bc, descr);

-- ---------- 4. bills of material ----------
drop table if exists seed._bom;
create table seed._bom(parent text, comp text, qty numeric);
insert into seed._bom
-- 8 oz jar candles: 0.45 lb wax, 0.6 oz FO (~8% load), wick, jar, lid, label, 0.02 oz dye
select p, c, q from (values
 ('CND-EZRA','FO-CEDAR'),('CND-MALLOW','FO-MALLOW'),('CND-ETHAN','FO-PINE'),('CND-TIEDYE','FO-TROPIC'),
 ('CND-TIMP','FO-BLOSSOM'),('CND-CANYON','FO-RAIN'),('CND-BEEHIVE','FO-HONEY'),('CND-COCOA','FO-COCOA')) f(p, c), lateral (select 0.6::numeric q) z
union all select p, d, 0.02 from (values ('CND-EZRA','DYE-RUST'),('CND-MALLOW','DYE-GLD'),('CND-ETHAN','DYE-GRN'),('CND-TIEDYE','DYE-ORG'),
 ('CND-TIMP','DYE-ORG'),('CND-CANYON','DYE-BLU'),('CND-BEEHIVE','DYE-GLD'),('CND-COCOA','DYE-RUST')) d(p, d)
union all select sku, case when sku = 'CND-BEEHIVE' then 'WAX-BEE' else 'WAX-SOY' end, 0.45 from items where category = 'candle_8oz'
union all select sku, c, 1 from items cross join (values ('WCK-08'),('JAR-08'),('LID-08'),('LBL-CND')) x(c) where category = 'candle_8oz'
-- 4 oz soaps: 0.27 lb base, 0.15 oz FO, 0.01 oz colorant, additive, wrap, label
union all select p, b, 0.27 from (values ('SOAP-LIZ','SB-GLY'),('SOAP-BROOKE','SB-GLY'),('SOAP-OAT','SB-GOAT'),
 ('SOAP-REDROCK','SB-SHEA'),('SOAP-WASATCH','SB-GOAT'),('SOAP-LEMON','SB-GLY')) b(p, b)
union all select p, f, 0.15 from (values ('SOAP-LIZ','FO-LAV'),('SOAP-BROOKE','FO-EUCA'),('SOAP-OAT','FO-OAT'),
 ('SOAP-REDROCK','FO-SANDAL'),('SOAP-WASATCH','FO-COCOMINT'),('SOAP-LEMON','FO-LEMON')) f(p, f)
union all select p, c, 0.01 from (values ('SOAP-LIZ','COL-PUR'),('SOAP-BROOKE','COL-GRN'),('SOAP-OAT','COL-YEL'),
 ('SOAP-REDROCK','COL-TER'),('SOAP-WASATCH','COL-BLU'),('SOAP-LEMON','COL-YEL')) c(p, c)
union all values ('SOAP-OAT','ADD-OAT',0.20), ('SOAP-REDROCK','ADD-CLAY',0.10), ('SOAP-LEMON','ADD-POPPY',0.05)
union all select sku, c, 1 from items cross join (values ('WRP-SOAP'),('LBL-SOAP')) x(c) where category = 'soap'
-- 4 oz mini tins: 0.23 lb soy, 0.3 oz FO, small wick, tin, mini label
union all select sku, 'WAX-SOY', 0.23 from items where category = 'mini_tin'
union all select p, f, 0.3 from (values ('MINI-EZRA','FO-CEDAR'),('MINI-MALLOW','FO-MALLOW'),('MINI-ETHAN','FO-PINE'),
 ('MINI-TIEDYE','FO-TROPIC'),('MINI-LIZ','FO-LAV'),('MINI-BROOKE','FO-EUCA')) f(p, f)
union all select sku, c, 1 from items cross join (values ('WCK-04'),('TIN-04'),('LBL-MINI')) x(c) where category = 'mini_tin'
-- gift sets (2-level BOM: kit -> finished goods -> raw)
union all select 'KIT-SAMPLER', sku, 1 from items where category = 'mini_tin'
union all values ('KIT-SAMPLER','BOX-LG',1), ('KIT-SAMPLER','FILL-CRK',1.5),
 ('KIT-COZY','CND-COCOA',1), ('KIT-COZY','SOAP-OAT',1), ('KIT-COZY','ACC-TRIM',1), ('KIT-COZY','BOX-SM',1),
 ('KIT-FRESH','CND-CANYON',1), ('KIT-FRESH','SOAP-BROOKE',1), ('KIT-FRESH','ACC-DISH',1), ('KIT-FRESH','BOX-SM',1),
 ('KIT-HOLIDAY','CND-EZRA',1), ('KIT-HOLIDAY','CND-ETHAN',1), ('KIT-HOLIDAY','CND-MALLOW',1), ('KIT-HOLIDAY','BOX-LG',1);

insert into bom_lines(parent_id, component_id, qty_per)
select p.id, c.id, b.qty from seed._bom b join items p on p.sku = b.parent join items c on c.sku = b.comp;
-- (seed._bom is kept until the next run; see note at the end of this file)

insert into supplier_items(supplier_id, item_id, supplier_sku, unit_cost, min_order_qty)
select preferred_supplier_id, id, 'S' || preferred_supplier_id || '-' || sku, std_cost,
       case uom when 'lb' then 50 when 'oz' then 32 else 48 end
  from items where item_type in ('raw','resale');

select app.rollup_std_cost();
update items set avg_cost = std_cost where item_type in ('finished','kit');

-- ---------- 5. demo logins + customers ----------
create or replace function seed.mk_user(p_id uuid, p_email text, p_pw text, p_name text) returns void language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
          extensions.crypt(p_pw, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_id::text, p_id, jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true),
          'email', now(), now(), now());
$$;
select seed.mk_user('e0000000-0000-4000-8000-000000000001','admin@emblet.test','EmbletAdmin!1','Avery Admin');
select seed.mk_user('e0000000-0000-4000-8000-000000000002','manager@emblet.test','EmbletManager!1','Morgan Manager');
select seed.mk_user('e0000000-0000-4000-8000-000000000003','cashier@emblet.test','EmbletCashier!1','Casey Cashier');
select seed.mk_user('e0000000-0000-4000-8000-000000000004','production@emblet.test','EmbletProduction!1','Parker Production');
select seed.mk_user('e0000000-0000-4000-8000-000000000011','customer@emblet.test','EmbletCustomer!1','Hannah Whitaker');
select seed.mk_user('e0000000-0000-4000-8000-000000000012','mia@emblet.test','EmbletCustomer!1','Mia Fonoti');
select seed.mk_user('e0000000-0000-4000-8000-000000000013','parkcity@emblet.test','EmbletWholesale!1','Main Street Mercantile');

-- the signup trigger made a profile + customer for each; set roles and rebuild the customer list
insert into profiles(id, email, full_name, role)
select id, email, raw_user_meta_data->>'full_name', 'customer' from auth.users where email like '%@emblet.test'
on conflict (id) do nothing;
update profiles set role = 'admin',      default_location = 'STR' where email = 'admin@emblet.test';
update profiles set role = 'manager',    default_location = 'STR' where email = 'manager@emblet.test';
update profiles set role = 'cashier',    default_location = 'STR' where email = 'cashier@emblet.test';
update profiles set role = 'production', default_location = 'WKS' where email = 'production@emblet.test';
delete from customers;
insert into customers(user_id, name, customer_type, contact_name, email, phone, address, city, terms_days) values
 ('e0000000-0000-4000-8000-000000000011','Hannah Whitaker','retail','Hannah Whitaker','customer@emblet.test','(801) 555-0210','480 N 200 E','Provo',0),
 ('e0000000-0000-4000-8000-000000000012','Mia Fonoti','retail','Mia Fonoti','mia@emblet.test','(801) 555-0211','1215 S State St','Orem',0),
 (null,'Jake Christensen','retail','Jake Christensen','jake.c@example.com','(801) 555-0212','33 W Main St','Lehi',0),
 (null,'Sophie Larsen','retail','Sophie Larsen','sophie.larsen@example.com','(801) 555-0213','275 S 400 E','Springville',0),
 (null,'Tanner Holt','retail','Tanner Holt','tholt@example.com','(801) 555-0214','88 E Pacific Dr','American Fork',0),
 (null,'Ava Nielsen','retail','Ava Nielsen','ava.n@example.com','(801) 555-0215','910 E 820 N','Provo',0),
 (null,'Carlos Medina','retail','Carlos Medina','cmedina@example.com','(801) 555-0216','120 N Main St','Spanish Fork',0),
 (null,'Grace Peterson','retail','Grace Peterson','grace.p@example.com','(801) 555-0217','455 W Center St','Pleasant Grove',0),
 (null,'Noah Jensen','retail','Noah Jensen','njensen@example.com','(385) 555-0218','1530 S 1100 E','Salt Lake City',0),
 (null,'Lily Tuiasosopo','retail','Lily Tuiasosopo','lily.t@example.com','(801) 555-0219','760 N 400 W','Orem',0),
 (null,'Summit Ridge Realty','retail','Brenda Cole','gifts@summitridge.example','(801) 555-0220','3301 N University Ave','Provo',0),
 ('e0000000-0000-4000-8000-000000000013','Main Street Mercantile','wholesale','Olivia Burke','buyer@mainstmerc.example','(435) 555-0230','562 Main St','Park City',30),
 (null,'Red Cliffs Gift Co.','wholesale','Ray Sorensen','orders@redcliffsgift.example','(435) 555-0231','2 W St George Blvd','St. George',30),
 (null,'Cache Valley Goods','wholesale','Emma Hansen','emma@cachevalleygoods.example','(435) 555-0232','45 N Main St','Logan',30);

-- ---------- 6. simulation helpers ----------
create table seed.dem(item_id int primary key, base numeric, profile text);
insert into seed.dem
select i.id, v.base, v.prof from (values
 ('CND-EZRA',2.2,'holiday'),('CND-MALLOW',2.0,'holiday'),('CND-ETHAN',1.9,'holiday'),('CND-TIEDYE',1.6,'summer'),
 ('CND-TIMP',1.5,'summer'),('CND-CANYON',1.6,'spring'),('CND-BEEHIVE',1.3,'steady'),('CND-COCOA',1.7,'holiday'),
 ('SOAP-LIZ',2.4,'steady'),('SOAP-BROOKE',1.8,'steady'),('SOAP-OAT',2.2,'steady'),('SOAP-REDROCK',1.4,'steady'),
 ('SOAP-WASATCH',1.5,'summer'),('SOAP-LEMON',1.5,'summer'),
 ('MINI-EZRA',0.7,'holiday'),('MINI-MALLOW',0.7,'holiday'),('MINI-ETHAN',0.65,'holiday'),('MINI-TIEDYE',0.7,'summer'),
 ('MINI-LIZ',0.75,'steady'),('MINI-BROOKE',0.65,'steady'),
 ('KIT-SAMPLER',0.45,'giftset'),('KIT-COZY',0.30,'holiday_only'),('KIT-FRESH',0.30,'giftset'),('KIT-HOLIDAY',0.35,'holiday_only'),
 ('ACC-TRIM',0.40,'steady'),('ACC-DISH',0.30,'steady')
) v(sku, base, prof) join items i on i.sku = v.sku;

create or replace function seed.season(p text, m int) returns numeric language sql immutable as $$
  select (case p
    when 'holiday'      then array[0.50,0.45,0.50,0.50,0.50,0.45,0.45,0.50,0.85,1.60,2.60,3.40]
    when 'holiday_only' then array[0.04,0.02,0.02,0.02,0.02,0.02,0.02,0.02,0.05,0.30,3.60,6.20]
    when 'giftset'      then array[0.50,0.85,0.50,0.60,0.95,0.50,0.40,0.40,0.60,1.30,2.60,3.60]
    when 'summer'       then array[0.50,0.55,0.80,1.10,1.40,1.70,1.80,1.60,1.10,0.80,0.70,0.60]
    when 'spring'       then array[0.70,0.80,1.40,1.80,1.60,1.00,0.80,0.80,0.90,0.90,0.80,0.80]
    else                     array[0.95,1.00,1.00,1.00,1.00,0.95,0.95,1.00,1.00,1.05,1.15,1.30] end)[m]::numeric
$$;
-- storefront closed Sundays; Fridays and Saturdays busiest  (index = dow+1, 0 = Sunday)
create or replace function seed.dowf(d date) returns numeric language sql immutable as $$
  select (array[0, 0.75, 0.75, 0.85, 0.95, 1.35, 1.60])[extract(dow from d)::int + 1]::numeric / 0.893 $$;
create or replace function seed.growth(d date) returns numeric language sql stable as $$
  select 0.88 + 0.24 * greatest(0, least(1, (d - (app.today() - 425))::numeric / 425)) $$;
create or replace function seed.normal() returns float8 language sql volatile as $$
  select sqrt(-2 * ln(greatest(random(), 1e-12))) * cos(2 * pi() * random()) $$;
create or replace function seed.poisson(lam numeric) returns int language plpgsql volatile as $$
declare l float8; k int := 0; p float8 := 1;
begin
  if lam is null or lam <= 0 then return 0; end if;
  if lam > 30 then return greatest(0, round(lam + sqrt(lam) * seed.normal())::int); end if;
  l := exp(-lam);
  loop k := k + 1; p := p * random(); exit when p <= l; end loop;
  return k - 1;
end $$;
create or replace function seed.pick(ids int[], cum numeric[]) returns int language plpgsql volatile as $$
declare r numeric := random() * cum[array_length(cum, 1)]; i int;
begin
  for i in 1..array_length(cum, 1) loop if r <= cum[i] then return ids[i]; end if; end loop;
  return ids[array_length(ids, 1)];
end $$;
create or replace function seed.ts(d date, hrs float8) returns timestamptz language sql immutable as $$
  select app.day_start(d) + make_interval(secs => hrs * 3600) $$;

-- expected daily demand per item per month (finished: direct; components: exploded through the BOM)
create table seed.exp_m(item_id int, m date, daily numeric, primary key (item_id, m));
insert into seed.exp_m
with recursive ex(top_id, item_id, mult) as (
  select item_id, item_id, 1::numeric from seed.dem
  union all select ex.top_id, b.component_id, ex.mult * b.qty_per from ex join bom_lines b on b.parent_id = ex.item_id),
months as (select generate_series(date_trunc('month', app.today() - 430)::date, date_trunc('month', app.today() + 60)::date, interval '1 month')::date m)
select ex.item_id, months.m,
       sum(d.base * seed.season(d.profile, extract(month from months.m)::int) * seed.growth(months.m) * 1.25 * ex.mult)
  from ex join seed.dem d on d.item_id = ex.top_id cross join months group by 1, 2;
create or replace function seed.exp(p_item int, d date) returns numeric language sql stable as $$
  select coalesce((select daily from seed.exp_m where item_id = p_item and m = date_trunc('month', d)::date), 0) $$;

create table seed.po_plan(po_id int primary key, arrive date, fill numeric);
create table seed.so_due(so_id int primary key, due date, kind text, tries int default 0);
create table seed.ret_plan(sale_id int, due date);
create table seed.ws_next(customer_id int primary key, next_date date);

-- ---------- 7. the simulation ----------
do $$
declare
  v_today date := app.today(); v_start date := app.today() - 425; d date; v_now timestamptz := now();
  u_mgr uuid := 'e0000000-0000-4000-8000-000000000002'; u_cash uuid := 'e0000000-0000-4000-8000-000000000003';
  u_prod uuid := 'e0000000-0000-4000-8000-000000000004';
  v_j bigint; r record; r2 record; it record; i int; k int; n int; v_m int; v_dowf numeric; v_g numeric;
  ids int[]; cum numeric[]; lams numeric[]; v_tot numeric; v_lines jsonb; v_seen int[]; v_item int; v_qty numeric;
  v_times numeric[]; v_sale int; v_cat text; v_oh numeric; v_need numeric; v_feas numeric; v_mo int; v_hrs numeric;
  v_rate numeric; v_scrap numeric; v_reason text; v_start_ts timestamptz; v_fin_ts timestamptz; v_pf timestamptz;
  v_sup int; v_po int; v_exp numeric; v_pos numeric; v_q numeric; v_arr date; v_fill numeric; v_late int;
  v_so int; v_cust int; v_ret_lines jsonb; v_disp text; v_new jsonb; v_amt numeric; v_retail int[]; v_reasons text[];
  v_no_reorder text[] := array['FO-COCOA','BOX-LG']; v_nl int;
begin
  select array_agg(id) into v_retail from customers where customer_type = 'retail';
  insert into seed.ws_next select id, v_start + 3 + (random()::numeric * 12)::int from customers where customer_type = 'wholesale';

  -- opening balances: cash + ~25 days of finished goods + ~40 days of materials
  v_j := app.new_journal();
  perform app.gl(v_j, v_start, '1000', 35000, 'OPENING', 'OPEN-1', 'Opening cash', u_mgr);
  perform app.gl(v_j, v_start, '3000', -35000, 'OPENING', 'OPEN-1', 'Owner investment', u_mgr);
  for it in select i.*, seed.exp(i.id, v_start + 15) e from items i loop
    if it.item_type in ('finished','kit','resale') then
      v_q := ceil(it.e * 26);
      if v_q > 0 then
        perform app.post_inv(it.id, 'STR', ceil(v_q * 0.4), it.avg_cost, 'OPENING', null, 'OPENING', null, 'OPEN-1', seed.ts(v_start, 6), u_mgr);
        perform app.post_inv(it.id, 'WKS', ceil(v_q * 0.4), it.avg_cost, 'OPENING', null, 'OPENING', null, 'OPEN-1', seed.ts(v_start, 6), u_mgr);
        perform app.post_inv(it.id, 'WHS', ceil(v_q * 0.2), it.avg_cost, 'OPENING', null, 'OPENING', null, 'OPEN-1', seed.ts(v_start, 6), u_mgr);
      end if;
    else
      v_q := ceil(it.e * 42 + coalesce((select max(b.qty_per * p.batch_size) from bom_lines b join items p on p.id = b.parent_id where b.component_id = it.id), 0));
      if v_q > 0 then
        perform app.post_inv(it.id, 'WKS', ceil(v_q * 0.6), it.avg_cost, 'OPENING', null, 'OPENING', null, 'OPEN-1', seed.ts(v_start, 6), u_mgr);
        perform app.post_inv(it.id, 'WHS', ceil(v_q * 0.4), it.avg_cost, 'OPENING', null, 'OPENING', null, 'OPEN-1', seed.ts(v_start, 6), u_mgr);
      end if;
    end if;
  end loop;
  v_j := app.new_journal();
  for r in select app.inv_account(t.item_id) acct, round(sum(t.qty * t.unit_cost), 2) v from inventory_transactions t group by 1 loop
    perform app.gl(v_j, v_start, r.acct, r.v, 'OPENING', 'OPEN-1', 'Opening inventory', u_mgr);
    perform app.gl(v_j, v_start, '3000', -r.v, 'OPENING', 'OPEN-1', 'Opening inventory', u_mgr);
  end loop;

  d := v_start - 1;
  while d < v_today loop
    d := d + 1;
    v_m := extract(month from d)::int;
    v_dowf := seed.dowf(d);
    v_g := seed.growth(d);

    -- (a) supplier deliveries arriving today
    for r in select p.*, pp.fill from seed.po_plan pp join purchase_orders p on p.id = pp.po_id
              where pp.arrive = d and p.status = 'ORDER_SENT' loop
      select jsonb_agg(jsonb_build_object('po_line_id', id, 'qty',
               case when r.fill >= 1 then qty_ordered else greatest(1, floor(qty_ordered * (r.fill + (random()::numeric - 0.5) * 0.1))) end))
        into v_lines from po_lines where po_id = r.id;
      perform app._receive_po(r.id, r.ship_to, v_lines, d, u_mgr);
      if r.fill < 1 then update purchase_orders set status = 'CLOSED' where id = r.id; end if;   -- short-shipped; supplier won't ship the rest
    end loop;
    update purchase_orders set status = 'CLOSED' where status = 'RECEIVED' and order_date < d - 30;

    -- (b) pay suppliers (2/10 terms: on the discount date; others: day before due) — a few deliberately left unpaid
    for r in select a.*, s.payment_terms from ap_invoices a join suppliers s on s.id = a.supplier_id
              where a.status = 'OPEN'
                and (case when s.payment_terms = '2/10 Net 30' then a.discount_date else a.due_date - 1 end) = d
                and not (a.supplier_id = 3 and a.due_date >= v_today - 25)
                and not (a.supplier_id = 5 and a.due_date >= v_today - 12) loop
      perform app._pay_ap(r.id, null, d, true, u_mgr);
    end loop;

    -- (c) wholesale customers pay (Red Cliffs pays late)
    for r in select a.*, c.name from ar_invoices a join customers c on c.id = a.customer_id
              where a.status = 'OPEN'
                and a.due_date + case when c.name = 'Red Cliffs Gift Co.' then 12 else -3 end = d
                and not (c.name = 'Red Cliffs Gift Co.' and a.due_date >= v_today - 30) loop
      perform app._ar_payment(r.id, r.amount - r.amount_paid, d, u_mgr);
    end loop;

    -- (d) monthly operating expenses (posted on the 1st)
    if extract(day from d) = 1 then
      v_j := app.new_journal();
      v_amt := round(7400 * v_g * (case when v_m in (11,12) then 1.25 else 1 end), 2);
      perform app.gl(v_j, d, '6000', v_amt, 'EXPENSE', 'PAYROLL-' || to_char(d,'YYYYMM'), 'Payroll', u_mgr);
      perform app.gl(v_j, d, '6100', 3450, 'EXPENSE', 'RENT-' || to_char(d,'YYYYMM'), 'Rent: Orem, Springville, Provo', u_mgr);
      perform app.gl(v_j, d, '6200', round(520 + case when v_m in (12,1,2) then 260 else 0 end + random()::numeric * 80, 2), 'EXPENSE', 'UTIL-' || to_char(d,'YYYYMM'), 'Utilities', u_mgr);
      perform app.gl(v_j, d, '6300', case when v_m in (10,11,12) then 950 else 420 end, 'EXPENSE', 'MKT-' || to_char(d,'YYYYMM'), 'Marketing & markets', u_mgr);
      select round(coalesce(sum(amount), 0) * 0.026, 2) into v_amt from payments
       where method = 'CARD' and paid_at >= app.day_start((d - interval '1 month')::date) and paid_at < app.day_start(d);
      perform app.gl(v_j, d, '6400', v_amt, 'EXPENSE', 'CARD-' || to_char(d,'YYYYMM'), 'Card processing fees', u_mgr);
      select -sum(debit - credit) into v_amt from gl_entries where journal_id = v_j;
      perform app.gl(v_j, d, '1000', v_amt, 'EXPENSE', 'EXP-' || to_char(d,'YYYYMM'), 'Cash paid', u_mgr);
    end if;

    -- (e) move bulk raw materials Warehouse -> Workshop when the Workshop runs low
    for r in select i.id, i.uom, seed.exp(i.id, d) e, app.on_hand(i.id, 'WKS') wks, app.on_hand(i.id, 'WHS') whs
               from items i where i.item_type = 'raw' loop
      if r.e > 0 and r.wks < r.e * 12 and r.whs > 0 then
        v_q := least(r.whs, ceil(r.e * 25));
        if v_q > 0 then perform app._transfer(r.id, 'WHS', 'WKS', v_q, 'Replenish workshop', seed.ts(d, 7), u_prod); end if;
      end if;
    end loop;

    -- (f) production: make what is running low (candles, soaps, tins first; then gift-set assembly)
    if extract(dow from d) between 1 and 5 then
      for it in select i.*, seed.exp(i.id, d + 7) e,
                   (select coalesce(sum(qty),0) from inventory_balances b where b.item_id = i.id and b.location_code <> 'QAH') pos,
                   (select coalesce(sum(l.qty_ordered - l.qty_fulfilled),0) from so_lines l join sales_orders o on o.id = l.so_id
                     where l.item_id = i.id and o.status in ('ORDER_PLACED','PARTIALLY_FULFILLED')) open_so
                  from items i where i.item_type in ('finished','kit') order by (i.item_type = 'kit'), i.sku loop
        if (d >= v_today - 9 and it.sku = 'CND-COCOA') or (d >= v_today - 30 and it.sku in ('SOAP-LIZ','CND-TIEDYE')) or d = v_today then continue; end if;
        if it.pos >= it.e * 8 + it.open_so then continue; end if;
        v_need := greatest(it.batch_size, ceil((it.e * 45 + it.open_so - it.pos) / it.batch_size) * it.batch_size);
        v_need := least(v_need, it.batch_size * 3);
        -- pull components to the workshop if they sit in the warehouse
        for r in select b.component_id, b.qty_per from bom_lines b where b.parent_id = it.id loop
          v_oh := app.on_hand(r.component_id, 'WKS');
          if v_oh < v_need * r.qty_per and app.on_hand(r.component_id, 'WHS') > 0 then
            perform app._transfer(r.component_id, 'WHS', 'WKS', least(app.on_hand(r.component_id, 'WHS'), ceil(v_need * r.qty_per - v_oh)),
                                  'Stage for production', seed.ts(d, 6.5), u_prod);
          end if;
        end loop;
        select floor(min(app.on_hand(b.component_id, 'WKS') / b.qty_per)) into v_feas from bom_lines b where b.parent_id = it.id;
        v_need := least(v_need, floor(v_feas / 12) * 12);
        if v_need < 12 then continue; end if;
        v_rate := case it.category when 'candle_8oz' then 18 when 'mini_tin' then 24 when 'soap' then 30 else 12 end;
        v_hrs := v_need / v_rate;
        v_start_ts := seed.ts(d, 7 + random()::numeric * 1.5);
        v_pf := v_start_ts + make_interval(secs => (v_hrs * 3600)::float8);
        v_mo := app._create_mo(it.id, v_need, 'WKS', v_start_ts, v_pf, u_prod);
        update production_orders set created_at = v_start_ts - interval '1 day' where id = v_mo;
        perform app._issue_mo(v_mo, v_start_ts + make_interval(mins => (random()::numeric * 25)::int), u_prod);
        -- quality: scrap rates by product line (Beehive's beeswax blend is the troublemaker)
        v_rate := case when it.sku = 'CND-BEEHIVE' then 0.085 when it.category = 'candle_8oz' then 0.04
                       when it.category = 'mini_tin' then 0.03 when it.category = 'soap' then 0.025 else 0.006 end;
        v_scrap := least(v_need - 1, greatest(0, round(v_need * v_rate * (0.3 + random()::numeric * 1.4))));
        v_reasons := case when it.sku = 'CND-BEEHIVE' then array['FROSTING','FROSTING','SINKHOLE','WET_SPOTS','WICK_OFF_CENTER']
                          when it.category in ('candle_8oz','mini_tin') then array['FROSTING','WET_SPOTS','SINKHOLE','WICK_OFF_CENTER','WICK_OFF_CENTER','LABEL_MISPRINT']
                          when it.category = 'soap' then array['AIR_BUBBLES','AIR_BUBBLES','SEPARATION','LABEL_MISPRINT']
                          else array['LABEL_MISPRINT'] end;
        v_reason := v_reasons[1 + floor(random()::numeric * array_length(v_reasons, 1))::int];
        v_fin_ts := v_start_ts + make_interval(secs => (v_hrs * 3600 * (0.84 + random()::numeric * 0.24))::float8);
        perform app._complete_mo(v_mo, v_need - v_scrap, v_scrap, case when v_scrap > 0 then v_reason end,
                                 v_start_ts + make_interval(mins => (random()::numeric * 12)::int), v_fin_ts, u_prod);
        -- send some overflow to the warehouse
        if it.item_type = 'finished' and random()::numeric < 0.35 then
          perform app._transfer(it.id, 'WKS', 'WHS', floor((v_need - v_scrap) * 0.25), 'Overflow to warehouse', v_fin_ts + interval '30 min', u_prod);
        end if;
      end loop;
    end if;

    -- (g) keep the storefront stocked (transfer from Workshop, then Warehouse)
    for it in select i.id, seed.exp(i.id, d) / 1.25 e, app.on_hand(i.id, 'STR') str from items i
               where i.item_type in ('finished','kit','resale') loop
      if it.e > 0 and it.str < it.e * 5 then
        v_need := ceil(it.e * 12 - it.str);
        v_q := least(v_need, app.on_hand(it.id, 'WKS'));
        if v_q > 0 then perform app._transfer(it.id, 'WKS', 'STR', v_q, 'Storefront replenishment', seed.ts(d, 9), u_cash); end if;
        v_need := v_need - greatest(v_q, 0);
        v_q := least(v_need, app.on_hand(it.id, 'WHS'));
        if v_q > 0 then perform app._transfer(it.id, 'WHS', 'STR', v_q, 'Storefront replenishment', seed.ts(d, 9), u_cash); end if;
      end if;
    end loop;

    -- (h) purchasing: reorder raw materials / resale items by supplier (one PO per supplier per day)
    if extract(dow from d) between 1 and 5 then
      for v_sup in 1..6 loop
        v_lines := '[]';
        for it in select i.*, s.quoted_lead_days lt from items i join suppliers s on s.id = i.preferred_supplier_id
                   where i.preferred_supplier_id = v_sup and i.item_type in ('raw','resale') loop
          if (d >= v_today - 26 and it.sku = any(v_no_reorder)) or (d >= v_today - 14 and it.sku = 'WCK-08') then continue; end if;
          v_exp := seed.exp(it.id, d + it.lt);
          if v_exp <= 0 then continue; end if;
          select coalesce(sum(qty), 0) into v_pos from inventory_balances where item_id = it.id and location_code <> 'QAH';
          v_pos := v_pos + coalesce((select sum(pl.qty_ordered - pl.qty_received) from po_lines pl join purchase_orders p on p.id = pl.po_id
                                      where pl.item_id = it.id and p.status in ('ORDER_SENT','PARTIALLY_RECEIVED')), 0);
          v_need := coalesce((select max(b.qty_per * p.batch_size) from bom_lines b join items p on p.id = b.parent_id where b.component_id = it.id), 0);
          if v_pos < v_exp * (it.lt + 14) + v_need then
            v_q := v_exp * (it.lt + 40) + v_need - v_pos;
            v_q := case it.uom when 'lb' then ceil(v_q / 25) * 25 when 'oz' then ceil(v_q / 16) * 16 else ceil(v_q / 24) * 24 end;
            v_lines := v_lines || jsonb_build_object('item_id', it.id, 'qty', v_q);
          end if;
        end loop;
        if jsonb_array_length(v_lines) > 0 then
          v_po := app._create_po(v_sup, case when v_sup in (1,3) and random()::numeric < 0.5 then 'WHS' else 'WKS' end, v_lines, d, null, u_mgr);
          -- supplier personality: 1 reliable, 2 often late, 3 short-ships (and late), 4-6 mixed
          v_late := case v_sup
             when 1 then case when random()::numeric < 0.08 then -1 else 0 end
             when 2 then case when random()::numeric < 0.42 then 1 + floor(random()::numeric * 4)::int else 0 end
             when 3 then case when random()::numeric < 0.62 then 3 + floor(random()::numeric * 5)::int else 0 end
             when 4 then case when random()::numeric < 0.25 then 1 + floor(random()::numeric * 3)::int else 0 end
             when 5 then case when random()::numeric < 0.30 then 1 + floor(random()::numeric * 4)::int else 0 end
             else        case when random()::numeric < 0.12 then 1 + floor(random()::numeric * 2)::int else 0 end end;
          v_fill := case v_sup
             when 3 then case when random()::numeric < 0.78 then 0.55 + random()::numeric * 0.2 else 1 end
             when 4 then case when random()::numeric < 0.10 then 0.9 else 1 end
             when 6 then case when random()::numeric < 0.05 then 0.9 else 1 end
             else 1 end;
          insert into seed.po_plan values (v_po, (select expected_date from purchase_orders where id = v_po) + v_late, v_fill);
        end if;
      end loop;
    end if;

    -- (i) wholesale boutiques place orders every ~2-3 weeks (heavier on holiday items in Q4)
    for r in select * from seed.ws_next where next_date = d and d < v_today - 9 loop
      select array_agg(dm.item_id), array_agg(dm.base * seed.season(dm.profile, extract(month from d + 7)::int))
        into ids, lams from seed.dem dm join items i on i.id = dm.item_id where i.item_type in ('finished','kit');
      v_tot := 0; cum := '{}';
      for i in 1..array_length(ids, 1) loop v_tot := v_tot + lams[i]; cum := cum || v_tot; end loop;
      v_lines := '[]'; v_seen := '{}';
      for k in 1..(4 + floor(random()::numeric * 4)::int) loop
        v_item := seed.pick(ids, cum);
        if v_item = any(v_seen) then continue; end if;
        v_seen := v_seen || v_item;
        v_lines := v_lines || jsonb_build_object('item_id', v_item, 'qty', 6 * (1 + floor(random()::numeric * case when v_m in (10,11,12) then 4 else 2 end)));
      end loop;
      v_so := app._create_so(r.customer_id, 'WHOLESALE', 'WHS', d + 7, v_lines, null, seed.ts(d, 10), u_mgr);
      insert into seed.so_due values (v_so, d + 7, 'WS');
      update seed.ws_next set next_date = d + 14 + floor(random()::numeric * 9)::int where customer_id = r.customer_id;
    end loop;

    -- (j) online pickup orders from retail customers
    if random()::numeric < 0.45 and d < v_today - 2 then
      select array_agg(dm.item_id), array_agg(dm.base * seed.season(dm.profile, v_m)) into ids, lams from seed.dem dm;
      v_tot := 0; cum := '{}';
      for i in 1..array_length(ids, 1) loop v_tot := v_tot + lams[i]; cum := cum || v_tot; end loop;
      v_lines := '[]'; v_seen := '{}';
      for k in 1..(1 + floor(random()::numeric * 3)::int) loop
        v_item := seed.pick(ids, cum);
        if v_item = any(v_seen) then continue; end if;
        v_seen := v_seen || v_item;
        v_lines := v_lines || jsonb_build_object('item_id', v_item, 'qty', 1 + floor(random()::numeric * 2));
      end loop;
      v_so := app._create_so(v_retail[1 + floor(random()::numeric * array_length(v_retail, 1))::int], 'ONLINE_PICKUP', 'STR',
                             d + 1 + floor(random()::numeric * 2)::int, v_lines, 'Website pickup order', seed.ts(d, 8 + random()::numeric * 12), u_cash);
      insert into seed.so_due select v_so, requested_date, 'PICKUP' from sales_orders where id = v_so;
    end if;

    -- (k) fulfil sales orders due today (wholesale picks from the warehouse; pickups at the storefront)
    for r in select sd.*, o.location_code loc, o.status from seed.so_due sd join sales_orders o on o.id = sd.so_id
              where sd.due <= d and o.status in ('ORDER_PLACED','PARTIALLY_FULFILLED') and d < v_today loop
      for r2 in select l.item_id, l.qty_ordered - l.qty_fulfilled q from so_lines l where l.so_id = r.so_id and l.qty_ordered > l.qty_fulfilled loop
        v_oh := app.on_hand(r2.item_id, r.loc);
        if v_oh < r2.q then
          v_q := least(r2.q - v_oh, app.on_hand(r2.item_id, 'WKS'));
          if v_q > 0 then perform app._transfer(r2.item_id, 'WKS', r.loc, v_q, 'Pick for order', seed.ts(d, 8.5), u_cash); end if;
          v_oh := app.on_hand(r2.item_id, r.loc);
          if v_oh < r2.q and r.loc <> 'WHS' then
            v_q := least(r2.q - v_oh, app.on_hand(r2.item_id, 'WHS'));
            if v_q > 0 then perform app._transfer(r2.item_id, 'WHS', r.loc, v_q, 'Pick for order', seed.ts(d, 8.5), u_cash); end if;
          end if;
        end if;
      end loop;
      begin
        perform app._fulfill_so(r.so_id, null, case when random()::numeric < 0.2 then 'CASH' else 'CARD' end, seed.ts(d, 11 + random()::numeric * 6), u_cash);
      exception when others then null;   -- nothing available yet: stays on backorder, retry tomorrow
      end;
      update seed.so_due set tries = tries + 1 where so_id = r.so_id;
      if (select status from sales_orders where id = r.so_id) = 'FULFILLED'
         or (r.tries >= 6 and (select status from sales_orders where id = r.so_id) = 'PARTIALLY_FULFILLED') then
        update so_lines set backordered = false where so_id = r.so_id;
        update sales_orders set status = 'CLOSED', updated_at = seed.ts(d, 18) where id = r.so_id;
      end if;
    end loop;

    -- (l) storefront POS sales (closed Sundays)
    if v_dowf > 0 then
      select array_agg(dm.item_id order by dm.item_id),
             array_agg(dm.base * seed.season(dm.profile, v_m) * v_g * v_dowf order by dm.item_id)
        into ids, lams from seed.dem dm;
      v_tot := 0; cum := '{}';
      for i in 1..array_length(ids, 1) loop v_tot := v_tot + lams[i]; cum := cum || v_tot; end loop;
      n := seed.poisson(v_tot / 1.95);
      for k in 1..n loop
        v_lines := '[]'; v_seen := '{}';
        v_nl := case when random()::numeric < 0.55 then 1 when random()::numeric < 0.62 then 2 when random()::numeric < 0.7 then 3 else 4 end;
        for i in 1..v_nl loop
          v_item := seed.pick(ids, cum);
          if v_item = any(v_seen) then continue; end if;
          select category into v_cat from items where id = v_item;
          v_qty := case when v_cat = 'soap' then (case when random()::numeric < 0.6 then 1 when random()::numeric < 0.75 then 2 else 3 end)
                        else (case when random()::numeric < 0.88 then 1 when random()::numeric < 0.83 then 2 else 3 end) end;
          v_qty := least(v_qty, app.on_hand(v_item, 'STR'));
          if v_qty <= 0 then continue; end if;      -- out of stock at the store = lost sale
          v_seen := v_seen || v_item;
          v_lines := v_lines || case when random()::numeric < 0.03
                       then jsonb_build_object('item_id', v_item, 'qty', v_qty, 'disc_type', 'PCT', 'disc_value', 20)
                       else jsonb_build_object('item_id', v_item, 'qty', v_qty) end;
        end loop;
        if jsonb_array_length(v_lines) = 0 then continue; end if;
        v_start_ts := seed.ts(d, 10 + 9 * (k - 0.5) / n + (random()::numeric - 0.5) * 0.3);
        if v_start_ts > v_now then exit; end if;
        v_amt := random()::numeric;
        v_sale := app._post_sale('STR', v_lines,
                    case when v_amt < 0.10 then 10 when v_amt < 0.13 then 5 else 0 end,
                    case when v_amt < 0.10 then 'PCT' else 'AMT' end,
                    case when random()::numeric < 0.18 then 'CASH' else 'CARD' end, 'POS',
                    case when random()::numeric < 0.2 then v_retail[1 + floor(random()::numeric * array_length(v_retail, 1))::int] end,
                    v_start_ts, u_cash);
        if random()::numeric < 0.032 then insert into seed.ret_plan values (v_sale, d + 1 + floor(random()::numeric * 18)::int); end if;
      end loop;
    end if;

    -- (m) returns & exchanges coming back today
    for r in select rp.sale_id from seed.ret_plan rp where rp.due = d and d < v_today loop
      select sl.id, sl.item_id, i.category, i.sku into r2 from sale_lines sl join items i on i.id = sl.item_id
       where sl.sale_id = r.sale_id and sl.qty > sl.qty_returned order by random()::numeric limit 1;
      if r2.id is null then continue; end if;
      v_reasons := case when r2.sku = 'CND-BEEHIVE' then array['WICK_DROWNED','WICK_DROWNED','TUNNELING','CHANGED_MIND','WRONG_SCENT']
                        when r2.sku = 'CND-TIEDYE' then array['WEAK_SCENT_THROW','WEAK_SCENT_THROW','CHANGED_MIND','WRONG_SCENT']
                        when r2.category in ('candle_8oz','mini_tin') then array['CHANGED_MIND','CHANGED_MIND','WRONG_SCENT','WRONG_SCENT','TUNNELING','CRACKED_JAR','WEAK_SCENT_THROW','WICK_DROWNED']
                        when r2.category = 'soap' then array['CHANGED_MIND','WRONG_SCENT','WRONG_SCENT','SOAP_SWEATING','SOAP_SWEATING']
                        else array['CHANGED_MIND','DAMAGED_IN_TRANSIT'] end;
      v_reason := v_reasons[1 + floor(random()::numeric * array_length(v_reasons, 1))::int];
      v_disp := case when v_reason in ('CHANGED_MIND','WRONG_SCENT') then 'RESTOCK'
                     when v_reason in ('CRACKED_JAR','DAMAGED_IN_TRANSIT') then 'SCRAP'
                     when random()::numeric < 0.6 then 'QA_HOLD' else 'SCRAP' end;
      v_ret_lines := jsonb_build_array(jsonb_build_object('sale_line_id', r2.id, 'qty', 1, 'reason_code', v_reason, 'disposition', v_disp));
      if v_reason in ('CHANGED_MIND','WRONG_SCENT') and random()::numeric < 0.35 then
        select i.id into v_item from items i where i.category = r2.category and i.id <> r2.item_id and app.on_hand(i.id, 'STR') > 0
         order by random()::numeric limit 1;
        if v_item is not null then
          perform app._process_exchange(r.sale_id, v_ret_lines, jsonb_build_array(jsonb_build_object('item_id', v_item, 'qty', 1)),
                                        'STR', 'CARD', seed.ts(d, 12 + random()::numeric * 5), u_cash);
          continue;
        end if;
      end if;
      perform app._process_return(r.sale_id, v_ret_lines, case when random()::numeric < 0.2 then 'CASH' else 'CARD' end, 'STR',
                                  seed.ts(d, 12 + random()::numeric * 5), u_cash, false, null);
    end loop;

    -- (n) Monday QA inspections of returned goods (recent returns stay in QA Hold for the demo)
    if extract(dow from d) = 1 and d < v_today - 14 then
      for r in select item_id, qty from inventory_balances where location_code = 'QAH' and qty > 0 loop
        v_q := floor(r.qty * 0.5);
        if v_q > 0 then perform app._transfer(r.item_id, 'QAH', 'STR', v_q, 'Passed QA inspection', seed.ts(d, 9.5), u_mgr); end if;
        if r.qty - v_q > 0 then perform app._adjust(r.item_id, 'QAH', -(r.qty - v_q), 'QA_SCRAP', 'Failed QA inspection', seed.ts(d, 9.6), u_mgr); end if;
      end loop;
    end if;

    -- (o) mid-month cycle counts, testers, breakage
    if extract(day from d) = 15 and d < v_today then
      for r in select i.id from items i where i.item_type = 'raw' and app.on_hand(i.id, 'WKS') > 20 order by random()::numeric limit 3 loop
        v_oh := app.on_hand(r.id, 'WKS');
        v_q := round(v_oh * (1 + seed.normal()::numeric * 0.015)) - v_oh;
        if v_q <> 0 then perform app._adjust(r.id, 'WKS', v_q, 'CYCLE_COUNT', 'Monthly cycle count', seed.ts(d, 17), u_prod, 'CYCLE_COUNT'); end if;
      end loop;
      for r in select i.id from items i where i.category = 'candle_8oz' and app.on_hand(i.id, 'STR') > 4 order by random()::numeric limit 2 loop
        perform app._adjust(r.id, 'STR', -1, 'SAMPLE_USE', 'New tester jar for the shelf', seed.ts(d, 9.2), u_cash);
      end loop;
      if app.on_hand((select id from items where sku = 'JAR-08'), 'WKS') > 10 then
        perform app._adjust((select id from items where sku = 'JAR-08'), 'WKS', -(1 + floor(random()::numeric * 4))::numeric, 'DAMAGED', 'Dropped case', seed.ts(d, 15), u_prod);
      end if;
      if random()::numeric < 0.3 and app.on_hand((select id from items where sku = 'LBL-CND'), 'WKS') > 0 then
        perform app._adjust((select id from items where sku = 'LBL-CND'), 'WKS', (12 + floor(random()::numeric * 30))::numeric, 'FOUND', 'Found a sleeve behind the shelf', seed.ts(d, 16), u_prod);
      end if;
    end if;
    if d = v_today - 160 then
      perform app._adjust((select id from items where sku = 'FO-RAIN'), 'WKS', -16, 'EXPIRED_FRAGRANCE', 'Bottle oxidized past shelf life', seed.ts(d, 14), u_prod);
    end if;
  end loop;
end $$;

-- ---------- 8. "today" state for the demo ----------
do $$
declare
  v_today date := app.today(); u_mgr uuid := 'e0000000-0000-4000-8000-000000000002';
  u_cash uuid := 'e0000000-0000-4000-8000-000000000003'; u_prod uuid := 'e0000000-0000-4000-8000-000000000004';
  v_so int; v_mo int; v_ts timestamptz; v_oh numeric; r record;
  function_item int;
  c_main int; c_red int; c_cache int; c_realty int; c_hannah int; c_mia int; c_ava int; c_jake int;
begin
  select id into c_main from customers where name = 'Main Street Mercantile';
  select id into c_red from customers where name = 'Red Cliffs Gift Co.';
  select id into c_cache from customers where name = 'Cache Valley Goods';
  select id into c_realty from customers where name = 'Summit Ridge Realty';
  select id into c_hannah from customers where name = 'Hannah Whitaker';
  select id into c_mia from customers where name = 'Mia Fonoti';
  select id into c_ava from customers where name = 'Ava Nielsen';
  select id into c_jake from customers where name = 'Jake Christensen';

  -- close out simulated orders still open, so today's open orders are exactly the scripted ones below
  update so_lines set backordered = false
   where so_id in (select id from sales_orders where status in ('ORDER_PLACED','PARTIALLY_FULFILLED'));
  update sales_orders set status = case when exists (select 1 from so_lines l where l.so_id = sales_orders.id and l.qty_fulfilled > 0)
                                        then 'CLOSED' else 'CANCELLED' end,
         notes = concat_ws(' | ', notes, 'Closed at period end')
   where status in ('ORDER_PLACED','PARTIALLY_FULFILLED');

  -- weekly replenishment run: keep at least half of each raw material at the Workshop
  for r in select i.id, app.on_hand(i.id,'WKS') wks, app.on_hand(i.id,'WHS') whs from items i where i.item_type = 'raw' loop
    if r.whs > 0 and r.wks < (r.wks + r.whs) * 0.5 then
      perform app._transfer(r.id, 'WHS', 'WKS', least(r.whs, ceil(((r.wks + r.whs) * 0.5 - r.wks) * 100) / 100), 'Weekly workshop replenishment',
                            app.day_start(v_today - 1) + interval '16 hours', u_prod);
    end if;
  end loop;

  -- Yesterday's Cabin Cocoa pour (scripted, so the QA-hold story never depends on what the simulation left over).
  select id into function_item from items where sku = 'CND-COCOA';
  perform app._transfer(b.component_id, 'WHS', 'WKS', least(app.on_hand(b.component_id, 'WHS'), 72 * b.qty_per - app.on_hand(b.component_id, 'WKS')),
                        'Stage for production', app.day_start(v_today - 1) + interval '6 hours 30 minutes', u_prod)
     from bom_lines b
    where b.parent_id = function_item and app.on_hand(b.component_id, 'WKS') < 72 * b.qty_per and app.on_hand(b.component_id, 'WHS') > 0;
  select floor(min(app.on_hand(b.component_id, 'WKS') / b.qty_per)) into v_oh from bom_lines b where b.parent_id = function_item;
  v_oh := least(72, floor(v_oh / 12) * 12);
  if v_oh >= 24 then
    v_mo := app._create_mo(function_item, v_oh, 'WKS', app.day_start(v_today - 1) + interval '7 hours',
                           app.day_start(v_today - 1) + interval '11 hours', u_prod, 'Holiday pour');
    perform app._issue_mo(v_mo, app.day_start(v_today - 1) + interval '7 hours', u_prod);
    perform app._complete_mo(v_mo, v_oh - 4, 4, 'WET_SPOTS', app.day_start(v_today - 1) + interval '7 hours 5 minutes',
                             app.day_start(v_today - 1) + interval '11 hours 20 minutes', u_prod);
  end if;

  -- Cabin Cocoa fragrance oil: a jug went cloudy -> nearly stocked out right before the holiday rush
  select id into function_item from items where sku = 'FO-COCOA';
  v_oh := app.on_hand(function_item, 'WHS');
  if v_oh > 0 then perform app._adjust(function_item, 'WHS', -v_oh, 'EXPIRED_FRAGRANCE', 'Jug went cloudy — disposed', app.day_start(v_today - 2) + interval '15 hours', u_prod); end if;
  v_oh := app.on_hand(function_item, 'WKS');
  if v_oh > 7 then perform app._adjust(function_item, 'WKS', -(v_oh - 7), 'EXPIRED_FRAGRANCE', 'Jug went cloudy — disposed', app.day_start(v_today - 2) + interval '15 hours', u_prod); end if;

  -- ...and the latest Cabin Cocoa pour is on QA HOLD (wet spots found during inspection).
  -- QA Hold is not sellable and MRP ignores it, so the holiday orders need a new pour -> which needs FO-COCOA.
  -- (Deterministic, so the MRP story is the same whatever day the seed is run.)
  select id into function_item from items where sku = 'CND-COCOA';
  v_oh := app.on_hand(function_item, 'WKS');
  if v_oh > 12 then perform app._transfer(function_item, 'WKS', 'QAH', v_oh - 12, 'QA hold: wet spots found in latest pour — awaiting inspection',
                                          app.day_start(v_today - 1) + interval '12 hours', u_prod); end if;
  v_oh := app.on_hand(function_item, 'WHS');
  if v_oh > 0 then perform app._transfer(function_item, 'WHS', 'QAH', v_oh, 'QA hold: same lot pulled from warehouse',
                                         app.day_start(v_today - 1) + interval '12 hours', u_prod); end if;
  -- fallback: if little was in back stock, pull the lot from the store shelf too (leave 12 for the POS demo)
  if app.on_hand(function_item, 'QAH') < 24 and app.on_hand(function_item, 'STR') > 12 then
    perform app._transfer(function_item, 'STR', 'QAH', least(app.on_hand(function_item, 'STR') - 12, 48),
                          'QA hold: same lot pulled from the storefront shelf', app.day_start(v_today - 1) + interval '16 hours', u_prod);
  end if;

  -- A box of 8 oz wicks got wet under a leaking swamp cooler: only 60 usable wicks remain,
  -- so the 8 oz wick is below ROP and tomorrow's Mallow Mal pour (144) is blocked at issue.
  select id into function_item from items where sku = 'WCK-08';
  v_oh := app.on_hand(function_item, 'WHS');
  if v_oh > 0 then perform app._adjust(function_item, 'WHS', -v_oh, 'DAMAGED', 'Box got wet under the swamp cooler', app.day_start(v_today - 1) + interval '9 hours', u_prod); end if;
  v_oh := app.on_hand(function_item, 'WKS');
  if v_oh > 60 then perform app._adjust(function_item, 'WKS', -(v_oh - 60), 'DAMAGED', 'Box got wet under the swamp cooler', app.day_start(v_today - 1) + interval '9 hours', u_prod); end if;
  update purchase_orders set status = 'CANCELLED'      -- no wick PO already on its way, so it really is below ROP
   where status = 'ORDER_SENT' and not exists (select 1 from po_receipts pr where pr.po_id = purchase_orders.id)
     and id in (select po_id from po_lines where item_id = function_item);

  -- Large gift boxes: a shelf collapsed and crushed most of them right before gift-set season -> below ROP.
  select id into function_item from items where sku = 'BOX-LG';
  v_oh := app.on_hand(function_item, 'WHS');
  if v_oh > 0 then perform app._adjust(function_item, 'WHS', -v_oh, 'DAMAGED', 'Shelf collapsed — boxes crushed', app.day_start(v_today - 3) + interval '14 hours', u_prod); end if;
  v_oh := app.on_hand(function_item, 'WKS');
  if v_oh > 4 then perform app._adjust(function_item, 'WKS', -(v_oh - 4), 'DAMAGED', 'Shelf collapsed — boxes crushed', app.day_start(v_today - 3) + interval '14 hours', u_prod); end if;
  update purchase_orders set status = 'CANCELLED'
   where status = 'ORDER_SENT' and not exists (select 1 from po_receipts pr where pr.po_id = purchase_orders.id)
     and id in (select po_id from po_lines where item_id = function_item);

  -- open confirmed sales orders over the next 4 weeks (these drive MRP)
  -- 1) the BIG boutique holiday order
  v_so := app._create_so(c_main, 'WHOLESALE', 'WHS', v_today + 12, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-HOLIDAY',60),('KIT-COZY',48),('CND-EZRA',48),('CND-ETHAN',48),('CND-COCOA',72),('KIT-SAMPLER',36)) x(sku,q)
            join items i on i.sku = x.sku) z), 'Holiday window display + gift wall', app.day_start(v_today - 3) + interval '10 hours', u_mgr);
  -- 2) Red Cliffs
  v_so := app._create_so(c_red, 'WHOLESALE', 'WHS', v_today + 6, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('CND-MALLOW',24),('CND-COCOA',24),('SOAP-OAT',36),('KIT-FRESH',12),('MINI-EZRA',24)) x(sku,q)
            join items i on i.sku = x.sku) z), null, app.day_start(v_today - 2) + interval '9 hours', u_mgr);
  -- 3) Cache Valley — due in 3 weeks
  v_so := app._create_so(c_cache, 'WHOLESALE', 'WHS', v_today + 19, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-SAMPLER',24),('CND-EZRA',24),('SOAP-LIZ',36),('KIT-HOLIDAY',24),('SOAP-WASATCH',24)) x(sku,q)
            join items i on i.sku = x.sku) z), null, app.day_start(v_today - 1) + interval '14 hours', u_mgr);
  -- 4) Cache Valley earlier order: partially shipped, remainder BACKORDERED
  v_so := app._create_so(c_cache, 'WHOLESALE', 'WHS', v_today - 2, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('CND-COCOA',36),('KIT-COZY',24),('SOAP-OAT',24)) x(sku,q) join items i on i.sku = x.sku) z),
            'Ship what is ready; backorder the rest', app.day_start(v_today - 9) + interval '10 hours', u_mgr);
  perform app._transfer(i.id, 'WKS', 'WHS', least(app.on_hand(i.id,'WKS'), greatest(0, x.q - app.on_hand(i.id,'WHS'))),
                        'Pick for order', app.day_start(v_today - 2) + interval '8 hours', u_cash)
     from (values ('CND-COCOA',12),('KIT-COZY',6),('SOAP-OAT',24)) x(sku,q) join items i on i.sku = x.sku
    where least(app.on_hand(i.id,'WKS'), greatest(0, x.q - app.on_hand(i.id,'WHS'))) > 0;
  perform app._fulfill_so(v_so, (select jsonb_agg(jsonb_build_object('so_line_id', l.id,
                'qty', least(app.on_hand(l.item_id, 'WHS'), case i.sku when 'CND-COCOA' then 12 when 'KIT-COZY' then 6 else 24 end)))
              from so_lines l join items i on i.id = l.item_id where l.so_id = v_so), 'ACCOUNT',
              app.day_start(v_today - 2) + interval '13 hours', u_cash);
  -- 5) corporate gift phone order
  v_so := app._create_so(c_realty, 'PHONE', 'STR', v_today + 9, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-COZY',20),('KIT-HOLIDAY',15)) x(sku,q) join items i on i.sku = x.sku) z),
            'Client closing gifts — wrap with ribbon', app.day_start(v_today - 4) + interval '11 hours', u_cash);
  -- 6-9) website pickup orders (show up in the storefront pickup queue)
  v_so := app._create_so(c_hannah, 'ONLINE_PICKUP', 'STR', v_today + 1, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('CND-COCOA',2),('SOAP-OAT',3)) x(sku,q) join items i on i.sku = x.sku) z),
            'Website pickup order', app.day_start(v_today - 1) + interval '20 hours', u_cash);
  v_so := app._create_so(c_mia, 'ONLINE_PICKUP', 'STR', v_today + 2, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-SAMPLER',1),('CND-ETHAN',1)) x(sku,q) join items i on i.sku = x.sku) z),
            'Website pickup order', app.day_start(v_today) + interval '7 hours', u_cash);
  v_so := app._create_so(c_ava, 'ONLINE_PICKUP', 'WHS', v_today + 5, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-HOLIDAY',2),('CND-MALLOW',2)) x(sku,q) join items i on i.sku = x.sku) z),
            'Website pickup order', app.day_start(v_today - 1) + interval '12 hours', u_cash);
  v_so := app._create_so(c_jake, 'ONLINE_PICKUP', 'STR', v_today + 20, (select jsonb_agg(jsonb_build_object('item_id', id, 'qty', q)) from (
            select i.id, x.q from (values ('KIT-COZY',3),('ACC-TRIM',2)) x(sku,q) join items i on i.sku = x.sku) z),
            'Holiday gifts — pickup before Christmas', app.day_start(v_today - 1) + interval '18 hours', u_cash);

  -- a few POs just sent (expected over the next 1-3 weeks)
  perform app._create_po(1, 'WHS', jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='WAX-SOY'), 'qty', 300),
                                                      jsonb_build_object('item_id', (select id from items where sku='WAX-BEE'), 'qty', 50)),
                         v_today - 1, 'Holiday wax build', u_mgr);
  perform app._create_po(3, 'WKS', jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='JAR-08'), 'qty', 480),
                                                      jsonb_build_object('item_id', (select id from items where sku='LID-08'), 'qty', 480),
                                                      jsonb_build_object('item_id', (select id from items where sku='TIN-04'), 'qty', 288)),
                         v_today - 2, null, u_mgr);
  perform app._create_po(2, 'WKS', jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='FO-PINE'), 'qty', 96),
                                                      jsonb_build_object('item_id', (select id from items where sku='FO-CEDAR'), 'qty', 96)),
                         v_today, 'Rush if possible', u_mgr);

  -- two production orders in progress right now + one planned for tomorrow
  v_ts := least(now() - interval '45 minutes', app.day_start(v_today) + interval '7 hours');
  -- pick two products whose components are on hand (workshop + warehouse), stage them, then issue (materials -> WIP)
  for r in select i.id, i.sku, i.batch_size q from items i
            where i.sku in ('SOAP-OAT','MINI-ETHAN','SOAP-BROOKE','MINI-EZRA','SOAP-WASATCH','CND-ETHAN','CND-EZRA','MINI-MALLOW')
              and not exists (select 1 from bom_lines b where b.parent_id = i.id
                               and app.on_hand(b.component_id,'WKS') + app.on_hand(b.component_id,'WHS') < b.qty_per * i.batch_size)
            order by array_position(array['SOAP-OAT','MINI-ETHAN','SOAP-BROOKE','MINI-EZRA','SOAP-WASATCH','CND-ETHAN','CND-EZRA','MINI-MALLOW'], i.sku)
            limit 2 loop
    perform app._transfer(b.component_id, 'WHS', 'WKS', b.qty_per * r.q - app.on_hand(b.component_id, 'WKS'),
                          'Stage for production', v_ts - interval '20 minutes', u_prod)
       from bom_lines b where b.parent_id = r.id and app.on_hand(b.component_id, 'WKS') < b.qty_per * r.q;
    v_mo := app._create_mo(r.id, r.q, 'WKS', v_ts, v_ts + make_interval(secs => (r.q / 24.0 * 3600)::float8), u_prod, 'Holiday build');
    perform app._issue_mo(v_mo, v_ts + interval '10 minutes', u_prod);
    v_ts := v_ts + interval '30 minutes';
  end loop;
  v_mo := app._create_mo((select id from items where sku = 'CND-MALLOW'), 144, 'WKS', app.day_start(v_today + 1) + interval '7 hours',
                         app.day_start(v_today + 1) + interval '15 hours', u_prod, 'Planned — issue tomorrow morning');
end $$;

-- The helper schema "seed" is kept on purpose (it is dropped and rebuilt at the top of this file).
-- Supabase's "Run and enable RLS" button appends ALTER TABLE ... ENABLE RLS for every table created
-- above and runs them last, so those tables must still exist when the script ends.
revoke all on schema seed from public;

-- quick sanity output
select 'items' what, count(*)::text n from items
union all select 'sales (receipts)', count(*)::text from sales
union all select 'sale lines', count(*)::text from sale_lines
union all select 'returns', count(*)::text from returns
union all select 'production orders (completed, last 6 mo)', count(*)::text from production_orders where status = 'COMPLETED' and actual_finish > now() - interval '6 months'
union all select 'purchase orders', count(*)::text from purchase_orders
union all select 'open POs', count(*)::text from purchase_orders where status in ('ORDER_SENT','PARTIALLY_RECEIVED')
union all select 'open sales orders', count(*)::text from sales_orders where status in ('ORDER_PLACED','PARTIALLY_FULFILLED')
union all select 'ledger rows', count(*)::text from inventory_transactions
union all select 'GL rows', count(*)::text from gl_entries
union all select 'GL out of balance by', (sum(debit) - sum(credit))::text from gl_entries
union all select 'ledger vs balance mismatches', count(*)::text from v_ledger_reconciliation where difference <> 0;
