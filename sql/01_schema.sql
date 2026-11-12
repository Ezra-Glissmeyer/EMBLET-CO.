-- =====================================================================
-- Emblet Co. Mini-ERP  |  01_schema.sql
-- Run order: 01_schema -> 02_functions -> 03_rls -> 04_seed
-- Re-runnable: drops and rebuilds every Emblet object (does NOT touch
-- Supabase's own schemas except removing @emblet.test demo users in 04).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- clean slate ----------
drop schema if exists app cascade;           -- internal (non-API) functions
drop table if exists
  mrp_pegging, mrp_lines, mrp_runs,
  ar_payments, ar_invoices, ap_payments, ap_invoices,
  receipt_lines, po_receipts, po_lines, purchase_orders,
  exchanges, return_lines, returns, payments, sale_lines, sales,
  so_lines, sales_orders,
  production_orders, lots,
  inventory_transactions, inventory_balances,
  gl_entries, gl_accounts,
  supplier_items, bom_lines, items, suppliers, customers,
  reason_codes, locations, profiles, settings, doc_counters
  cascade;
drop function if exists public.handle_new_user() cascade;
drop sequence if exists gl_journal_seq;

create schema app;

-- ---------- settings (single row) ----------
create table settings (
  id                    int primary key default 1 check (id = 1),
  company_name          text    not null default 'Emblet Co.',
  tagline               text    not null default 'Hand-poured in Utah',
  address               text    not null default '255 N University Ave, Provo, UT 84601',
  phone                 text    not null default '(801) 555-0142',
  sales_tax_rate        numeric(6,4) not null default 0.0725 check (sales_tax_rate between 0 and 0.25),
  ordering_cost         numeric(10,2) not null default 45.00 check (ordering_cost >= 0),   -- $ per PO / setup
  holding_cost_pct      numeric(6,4) not null default 0.25  check (holding_cost_pct > 0),  -- % of unit cost per year
  service_z             numeric(6,3) not null default 1.65  check (service_z >= 0),        -- 1.65 ~ 95% service
  review_period_days    int     not null default 7  check (review_period_days > 0),
  usage_window_days     int     not null default 90 check (usage_window_days between 14 and 400),
  wholesale_terms_days  int     not null default 30,
  wholesale_price_pct   numeric(5,3) not null default 0.55,  -- wholesale price = retail x this
  cure_days             int     not null default 3,
  score_keep_min        numeric(5,1) not null default 90,
  score_watch_min       numeric(5,1) not null default 75,
  return_policy         text    not null default 'Returns or exchanges within 30 days with receipt. Candles that tunnel or have a drowned wick are always replaced — we stand behind every pour.',
  updated_at            timestamptz not null default now()
);

-- ---------- simple per-type document numbering ----------
create table doc_counters (prefix text primary key, next_no int not null default 1);

-- ---------- locations ----------
create table locations (
  code        text primary key,
  name        text not null,
  purpose     text,
  sellable    boolean not null default true,     -- QA Hold is not sellable
  sort        int not null default 0
);

-- ---------- users / roles ----------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'customer'
              check (role in ('admin','manager','cashier','production','customer')),
  default_location text references locations(code),
  created_at  timestamptz not null default now()
);

-- ---------- reason codes ----------
create table reason_codes (
  code        text primary key,
  category    text not null check (category in ('ADJUST','RETURN','SCRAP','TRANSFER')),
  description text not null,
  is_quality  boolean not null default false,
  gl_account  text                       -- expense account for adjustments (5100 write-off / 5200 adjustment)
);

-- ---------- suppliers ----------
create table suppliers (
  id               serial primary key,
  name             text not null unique,
  contact_name     text,
  email            text,
  phone            text,
  address          text,
  quoted_lead_days int  not null check (quoted_lead_days >= 0),
  payment_terms    text not null default 'Net 30'
                   check (payment_terms in ('Net 15','Net 30','Net 45','2/10 Net 30')),
  notes            text,
  active           boolean not null default true
);

-- ---------- items ----------
create table items (
  id                    serial primary key,
  sku                   text not null unique,
  name                  text not null,
  item_type             text not null check (item_type in ('raw','finished','kit','resale')),
  category              text not null,          -- e.g. candle_8oz, mini_tin, soap, gift_set, wax, fragrance ...
  scent_family          text,                   -- woodsy / sweet / fresh / citrus / floral (finished goods)
  scent_notes           text,
  description           text,
  uom                   text not null,
  barcode               text not null unique,   -- Code 128 value e.g. EMB20001
  std_cost              numeric(12,4) not null default 0,
  avg_cost              numeric(12,4) not null default 0,   -- weighted average (all locations)
  price                 numeric(10,2),                      -- selling price (finished, kit, resale)
  reorder_point_override numeric(12,2),                     -- optional manual ROP; null = calculated
  lead_time_days        int  not null default 0,            -- supplier lead time, or production lead time for made items
  preferred_supplier_id int references suppliers(id),
  ordering_policy       text not null default 'ROP_EOQ' check (ordering_policy in ('ROP_EOQ','MRP')),
  batch_size            int,                                -- typical production batch (made items)
  color_hex             text default '#C8A27A',             -- used for the product mock-up image
  accent_hex            text default '#9CAF88',
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);
create index on items(item_type);

create table bom_lines (
  id            serial primary key,
  parent_id     int not null references items(id) on delete cascade,
  component_id  int not null references items(id),
  qty_per       numeric(12,4) not null check (qty_per > 0),
  unique (parent_id, component_id),
  check (parent_id <> component_id)
);

create table supplier_items (
  supplier_id   int not null references suppliers(id) on delete cascade,
  item_id       int not null references items(id) on delete cascade,
  supplier_sku  text,
  unit_cost     numeric(12,4) not null check (unit_cost >= 0),
  min_order_qty numeric(12,2) not null default 1,
  primary key (supplier_id, item_id)
);

-- ---------- customers ----------
create table customers (
  id          serial primary key,
  user_id     uuid unique references auth.users(id) on delete set null,
  name        text not null,
  customer_type text not null default 'retail' check (customer_type in ('retail','wholesale')),
  contact_name text,
  email       text,
  phone       text,
  address     text,
  city        text,
  terms_days  int not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- general ledger ----------
create table gl_accounts (
  code        text primary key,
  name        text not null,
  acct_type   text not null check (acct_type in ('asset','liability','equity','revenue','contra_revenue','expense','other_income')),
  sort        int not null default 0
);

create table gl_entries (
  id          bigserial primary key,
  journal_id  bigint not null,                 -- groups the lines of one balanced entry
  entry_date  date   not null,
  account_code text  not null references gl_accounts(code),
  debit       numeric(14,2) not null default 0 check (debit  >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  ref_type    text   not null,                 -- SALE, RETURN, PO_RECEIPT, PROD_ISSUE ...
  ref_no      text,
  memo        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create sequence gl_journal_seq;
create index on gl_entries(entry_date);
create index on gl_entries(account_code, entry_date);
create index on gl_entries(ref_type, ref_no);

-- ---------- inventory ----------
create table lots (
  id            serial primary key,
  lot_no        text not null unique,
  item_id       int  not null references items(id),
  production_order_id int,
  fragrance_lot text,
  poured_on     date,
  sellable_on   date,
  created_at    timestamptz not null default now()
);

-- THE source of truth for quantities
create table inventory_transactions (
  id            bigserial primary key,
  txn_at        timestamptz not null default now(),
  item_id       int  not null references items(id),
  location_code text not null references locations(code),
  qty           numeric(14,4) not null check (qty <> 0),   -- + in / - out
  unit_cost     numeric(12,4) not null default 0,
  txn_type      text not null check (txn_type in
                ('OPENING','PO_RECEIPT','SALE','RETURN','TRANSFER_OUT','TRANSFER_IN',
                 'ADJUSTMENT','CYCLE_COUNT','PROD_ISSUE','PROD_RECEIPT','SCRAP')),
  reason_code   text references reason_codes(code),
  ref_type      text,
  ref_id        bigint,
  ref_no        text,
  lot_no        text,
  user_id       uuid,
  note          text
);
create index on inventory_transactions(item_id, txn_at);
create index on inventory_transactions(txn_type, txn_at);
create index on inventory_transactions(ref_type, ref_id);

-- Maintained balance table (always reconcilable to the ledger; see v_ledger_reconciliation)
create table inventory_balances (
  item_id       int  not null references items(id),
  location_code text not null references locations(code),
  qty           numeric(14,4) not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (item_id, location_code)
);

-- ---------- sales orders ----------
create table sales_orders (
  id             serial primary key,
  so_no          text not null unique,
  customer_id    int  not null references customers(id),
  channel        text not null check (channel in ('WHOLESALE','ONLINE_PICKUP','PHONE')),
  location_code  text not null references locations(code),     -- fulfillment / pickup location
  order_date     date not null default current_date,
  requested_date date not null,
  status         text not null default 'ORDER_PLACED'
                 check (status in ('ORDER_PLACED','PARTIALLY_FULFILLED','FULFILLED','CLOSED','CANCELLED')),
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on sales_orders(status, requested_date);

create table so_lines (
  id            serial primary key,
  so_id         int  not null references sales_orders(id) on delete cascade,
  line_no       int  not null,
  item_id       int  not null references items(id),
  qty_ordered   numeric(12,2) not null check (qty_ordered > 0),
  qty_fulfilled numeric(12,2) not null default 0,
  unit_price    numeric(10,2) not null,
  discount_pct  numeric(5,2)  not null default 0,
  backordered   boolean not null default false
);

-- ---------- sales (POS receipts and SO invoices) ----------
create table sales (
  id               serial primary key,
  receipt_no       text not null unique,
  sale_at          timestamptz not null default now(),
  location_code    text not null references locations(code),
  channel          text not null check (channel in ('POS','ONLINE_PICKUP','WHOLESALE','PHONE','EXCHANGE')),
  customer_id      int references customers(id),
  sales_order_id   int references sales_orders(id),
  cashier_id       uuid,
  subtotal         numeric(12,2) not null,          -- gross qty*price
  line_discounts   numeric(12,2) not null default 0,
  order_discount   numeric(12,2) not null default 0,
  tax_rate         numeric(6,4)  not null,
  tax              numeric(12,2) not null,
  total            numeric(12,2) not null,
  payment_method   text not null check (payment_method in ('CASH','CARD','ACCOUNT','EXCHANGE_CREDIT')),
  cogs_total       numeric(12,2) not null default 0,
  note             text
);
create index on sales(sale_at);
create index on sales(customer_id);

create table sale_lines (
  id             serial primary key,
  sale_id        int  not null references sales(id) on delete cascade,
  line_no        int  not null,
  item_id        int  not null references items(id),
  qty            numeric(12,2) not null check (qty > 0),
  unit_price     numeric(10,2) not null,
  line_discount  numeric(12,2) not null default 0,     -- $ off this line
  order_disc_alloc numeric(12,2) not null default 0,   -- share of order-level discount
  net_amount     numeric(12,2) not null,               -- qty*price - line_discount - order_disc_alloc
  tax_amount     numeric(12,2) not null default 0,
  unit_cost      numeric(12,4) not null,               -- weighted avg cost at time of sale
  qty_returned   numeric(12,2) not null default 0,
  lot_no         text
);
create index on sale_lines(item_id);
create index on sale_lines(sale_id);

create table payments (
  id          serial primary key,
  sale_id     int references sales(id) on delete cascade,
  return_id   int,
  paid_at     timestamptz not null default now(),
  method      text not null,
  amount      numeric(12,2) not null          -- negative = refund
);

-- ---------- returns & exchanges ----------
create table returns (
  id            serial primary key,
  return_no     text not null unique,
  sale_id       int  not null references sales(id),
  return_at     timestamptz not null default now(),
  location_code text not null references locations(code),
  refund_method text not null,
  merchandise_amount numeric(12,2) not null,
  tax_refund    numeric(12,2) not null,
  refund_total  numeric(12,2) not null,
  is_exchange   boolean not null default false,
  processed_by  uuid,
  note          text
);
create table return_lines (
  id            serial primary key,
  return_id     int  not null references returns(id) on delete cascade,
  sale_line_id  int  not null references sale_lines(id),
  item_id       int  not null references items(id),
  qty           numeric(12,2) not null check (qty > 0),
  reason_code   text not null references reason_codes(code),
  disposition   text not null check (disposition in ('RESTOCK','QA_HOLD','SCRAP')),
  refund_amount numeric(12,2) not null,
  tax_refund    numeric(12,2) not null,
  unit_cost     numeric(12,4) not null
);
create index on return_lines(item_id);
create table exchanges (
  id            serial primary key,
  return_id     int not null references returns(id),
  new_sale_id   int not null references sales(id),
  price_difference numeric(12,2) not null,      -- + customer paid more, - refunded
  created_at    timestamptz not null default now()
);

-- ---------- purchasing ----------
create table purchase_orders (
  id             serial primary key,
  po_no          text not null unique,
  supplier_id    int  not null references suppliers(id),
  ship_to        text not null references locations(code),
  order_date     date not null default current_date,
  expected_date  date not null,                  -- order_date + quoted lead time
  status         text not null default 'ORDER_SENT'
                 check (status in ('ORDER_SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index on purchase_orders(supplier_id, status);

create table po_lines (
  id            serial primary key,
  po_id         int not null references purchase_orders(id) on delete cascade,
  line_no       int not null,
  item_id       int not null references items(id),
  qty_ordered   numeric(12,2) not null check (qty_ordered > 0),
  qty_received  numeric(12,2) not null default 0,
  unit_cost     numeric(12,4) not null
);

create table po_receipts (
  id            serial primary key,
  receipt_no    text not null unique,
  po_id         int  not null references purchase_orders(id),
  received_date date not null,
  location_code text not null references locations(code),
  days_late     int  not null,                    -- received_date - expected_date (negative = early)
  received_by   uuid,
  created_at    timestamptz not null default now()
);
create table receipt_lines (
  id            serial primary key,
  receipt_id    int not null references po_receipts(id) on delete cascade,
  po_line_id    int not null references po_lines(id),
  item_id       int not null references items(id),
  qty           numeric(12,2) not null check (qty > 0),
  unit_cost     numeric(12,4) not null
);

create table ap_invoices (
  id            serial primary key,
  invoice_no    text not null unique,
  supplier_id   int  not null references suppliers(id),
  po_id         int  references purchase_orders(id),
  receipt_id    int  references po_receipts(id),
  invoice_date  date not null,
  due_date      date not null,
  discount_date date,
  discount_pct  numeric(5,2) not null default 0,
  amount        numeric(12,2) not null,
  amount_paid   numeric(12,2) not null default 0,
  status        text not null default 'OPEN' check (status in ('OPEN','PAID'))
);
create table ap_payments (
  id            serial primary key,
  invoice_id    int not null references ap_invoices(id),
  paid_date     date not null,
  amount        numeric(12,2) not null check (amount > 0),
  discount_taken numeric(12,2) not null default 0,
  method        text not null default 'ACH',
  created_by    uuid
);

create table ar_invoices (
  id            serial primary key,
  invoice_no    text not null unique,
  customer_id   int not null references customers(id),
  sale_id       int not null references sales(id),
  invoice_date  date not null,
  due_date      date not null,
  amount        numeric(12,2) not null,
  amount_paid   numeric(12,2) not null default 0,
  status        text not null default 'OPEN' check (status in ('OPEN','PAID'))
);
create table ar_payments (
  id            serial primary key,
  invoice_id    int not null references ar_invoices(id),
  paid_date     date not null,
  amount        numeric(12,2) not null check (amount > 0),
  created_by    uuid
);

-- ---------- production ----------
create table production_orders (
  id              serial primary key,
  mo_no           text not null unique,
  item_id         int  not null references items(id),
  location_code   text not null references locations(code),
  qty_planned     numeric(12,2) not null check (qty_planned > 0),
  status          text not null default 'PLANNED'
                  check (status in ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  planned_start   timestamptz not null,
  planned_finish  timestamptz not null,
  actual_start    timestamptz,
  actual_finish   timestamptz,
  qty_started     numeric(12,2),
  qty_good        numeric(12,2),
  qty_scrap       numeric(12,2),
  scrap_reason    text references reason_codes(code),
  component_cost  numeric(14,2) not null default 0,   -- actual cost issued
  actual_unit_cost numeric(12,4),
  std_unit_cost   numeric(12,4),                       -- snapshot of standard at completion
  lot_no          text,
  fragrance_lot   text,
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index on production_orders(status, planned_finish);

-- ---------- MRP output ----------
create table mrp_runs (
  id            serial primary key,
  run_at        timestamptz not null default now(),
  run_by        uuid,
  weeks         int not null,
  lot_rule      text not null,
  demand_mult   numeric(6,3) not null default 1,
  include_forecast boolean not null default false,
  label         text
);
create table mrp_lines (
  run_id        int not null references mrp_runs(id) on delete cascade,
  item_id       int not null references items(id),
  llc           int not null,                  -- low-level code (0 = top)
  week_no       int not null,                  -- 1..N
  week_start    date not null,
  gross_req     numeric(14,2) not null default 0,
  sched_receipts numeric(14,2) not null default 0,
  proj_on_hand  numeric(14,2) not null default 0,
  net_req       numeric(14,2) not null default 0,
  planned_receipt numeric(14,2) not null default 0,
  planned_release numeric(14,2) not null default 0,  -- qty to release in this row's release date
  release_date  date,
  past_due      boolean not null default false,
  primary key (run_id, item_id, week_no)
);
create table mrp_pegging (
  id            bigserial primary key,
  run_id        int not null references mrp_runs(id) on delete cascade,
  item_id       int not null references items(id),
  source_type   text not null,       -- SO | PROD_ORDER | FORECAST | PLANNED
  source_no     text,
  customer_name text,
  top_item_id   int references items(id),
  path          text,
  need_date     date not null,
  week_no       int not null,
  qty           numeric(14,2) not null
);
create index on mrp_pegging(run_id, item_id);
