-- =====================================================================
-- Emblet Co. Mini-ERP  |  02_functions.sql
-- Every business transaction is a Postgres function (atomic, one
-- transaction). Internal workers live in schema "app" (NOT exposed by the
-- Supabase API); public wrappers check the caller's role and call them.
-- Reports are views / functions so every number recalculates live.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------
create or replace function app.tz() returns text language sql immutable as $$ select 'America/Denver' $$;
create or replace function app.today() returns date language sql stable as $$ select (now() at time zone 'America/Denver')::date $$;
create or replace function app.biz_date(ts timestamptz) returns date language sql immutable as $$ select (ts at time zone 'America/Denver')::date $$;
-- start of a business day as a timestamptz
create or replace function app.day_start(d date) returns timestamptz language sql immutable as $$ select (d::timestamp at time zone 'America/Denver') $$;

create or replace function app.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function app.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','manager','cashier','production') from public.profiles where id = auth.uid()), false)
$$;
create or replace function app.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','manager') from public.profiles where id = auth.uid()), false)
$$;
create or replace function app.my_customer_id() returns int
language sql stable security definer set search_path = public as $$
  select id from public.customers where user_id = auth.uid()
$$;

-- Raises unless the signed-in user has one of the roles (admin always passes).
-- When run from the SQL editor (no JWT, session user postgres) the check is skipped so the seed can post history.
create or replace function app.require_role(p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text;
begin
  if v_uid is null then
    if session_user in ('postgres','supabase_admin') then return null; end if;
    raise exception 'You must be signed in to do this.' using errcode = '42501';
  end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is null or not (v_role = 'admin' or v_role = any(p_roles)) then
    raise exception 'Permission denied: the % role cannot perform this action.', coalesce(v_role,'unknown') using errcode = '42501';
  end if;
  return v_uid;
end $$;

create or replace function app.next_no(p_prefix text) returns text
language plpgsql as $$
declare n int;
begin
  insert into doc_counters(prefix, next_no) values (p_prefix, 2)
  on conflict (prefix) do update set next_no = doc_counters.next_no + 1
  returning next_no - 1 into n;
  return p_prefix || '-' || lpad(n::text, 5, '0');
end $$;

-- Inventory GL account for an item
create or replace function app.inv_account(p_item int) returns text
language sql stable as $$
  select case when item_type = 'raw' then '1200' else '1210' end from items where id = p_item
$$;

create or replace function app.terms_days(p_terms text) returns int language sql immutable as $$
  select case p_terms when 'Net 15' then 15 when 'Net 45' then 45 else 30 end $$;

-- ---------------------------------------------------------------------
-- 1. General ledger helpers
-- ---------------------------------------------------------------------
create or replace function app.new_journal() returns bigint language sql as $$ select nextval('gl_journal_seq') $$;

-- p_amount > 0 = debit, < 0 = credit
create or replace function app.gl(p_journal bigint, p_date date, p_account text, p_amount numeric,
                                  p_ref_type text, p_ref_no text, p_memo text, p_user uuid)
returns void language plpgsql as $$
begin
  p_amount := round(coalesce(p_amount,0), 2);
  if p_amount = 0 then return; end if;
  insert into gl_entries(journal_id, entry_date, account_code, debit, credit, ref_type, ref_no, memo, created_by)
  values (p_journal, p_date, p_account, greatest(p_amount,0), greatest(-p_amount,0), p_ref_type, p_ref_no, p_memo, p_user);
end $$;

create or replace function app.gl_check(p_journal bigint) returns void language plpgsql as $$
declare d numeric; c numeric;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from gl_entries where journal_id = p_journal;
  if d <> c then raise exception 'GL journal % is out of balance (debits % / credits %)', p_journal, d, c; end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Inventory ledger helpers
-- ---------------------------------------------------------------------
-- Balance table is maintained ONLY from the ledger (trigger), and can never go negative.
create or replace function app.trg_apply_ledger() returns trigger language plpgsql as $$
declare v_new numeric; v_sku text;
begin
  insert into inventory_balances(item_id, location_code, qty, updated_at)
  values (new.item_id, new.location_code, new.qty, now())
  on conflict (item_id, location_code)
  do update set qty = inventory_balances.qty + excluded.qty, updated_at = now()
  returning qty into v_new;
  if v_new < -0.0001 then
    select sku into v_sku from items where id = new.item_id;
    raise exception 'INSUFFICIENT_STOCK: % at % would go to % (short by %)', v_sku, new.location_code,
      round(v_new,2), round(-v_new,2) using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists inventory_ledger_apply on inventory_transactions;
create trigger inventory_ledger_apply after insert on inventory_transactions
  for each row execute function app.trg_apply_ledger();

-- The ledger is append-only
create or replace function app.trg_ledger_immutable() returns trigger language plpgsql as $$
begin raise exception 'The inventory ledger is append-only; post a correcting transaction instead.'; end $$;
drop trigger if exists inventory_ledger_no_update on inventory_transactions;
create trigger inventory_ledger_no_update before update or delete on inventory_transactions
  for each row execute function app.trg_ledger_immutable();

create or replace function app.post_inv(p_item int, p_loc text, p_qty numeric, p_cost numeric, p_type text,
  p_reason text, p_ref_type text, p_ref_id bigint, p_ref_no text, p_at timestamptz, p_user uuid,
  p_note text default null, p_lot text default null)
returns void language plpgsql as $$
begin
  if p_qty = 0 then return; end if;
  insert into inventory_transactions(txn_at, item_id, location_code, qty, unit_cost, txn_type, reason_code,
                                     ref_type, ref_id, ref_no, lot_no, user_id, note)
  values (p_at, p_item, p_loc, p_qty, round(p_cost,4), p_type, p_reason, p_ref_type, p_ref_id, p_ref_no, p_lot, p_user, p_note);
end $$;

-- Weighted-average cost update for an inbound quantity (call BEFORE posting the receipt)
create or replace function app.receive_cost(p_item int, p_qty numeric, p_cost numeric) returns void
language plpgsql as $$
declare v_oh numeric;
begin
  select coalesce(sum(qty),0) into v_oh from inventory_balances where item_id = p_item;
  update items
     set avg_cost = case when v_oh <= 0 then round(p_cost,4)
                         else round((v_oh * avg_cost + p_qty * p_cost) / (v_oh + p_qty), 4) end
   where id = p_item;
end $$;

create or replace function app.on_hand(p_item int, p_loc text) returns numeric language sql stable as $$
  select coalesce((select qty from inventory_balances where item_id = p_item and location_code = p_loc), 0)
$$;

-- ---------------------------------------------------------------------
-- 3. SALES  (POS receipts and sales-order invoices share this logic)
-- p_lines: [{item_id, qty, unit_price?, disc_type:'PCT'|'AMT', disc_value}]
-- ---------------------------------------------------------------------
create or replace function app._post_sale(
  p_location text, p_lines jsonb, p_order_disc numeric, p_order_disc_type text, p_payment text,
  p_channel text, p_customer int, p_at timestamptz, p_user uuid,
  p_so_id int default null, p_tax_rate numeric default null, p_note text default null)
returns int language plpgsql as $$
declare
  v_rate numeric; v_sale int; v_no text; v_j bigint; v_date date := app.biz_date(p_at);
  n int; i int; ln jsonb; it record;
  a_item int[] := '{}'; a_qty numeric[] := '{}'; a_price numeric[] := '{}'; a_ldisc numeric[] := '{}';
  a_after numeric[] := '{}'; a_alloc numeric[] := '{}'; a_net numeric[] := '{}'; a_tax numeric[] := '{}';
  a_cost numeric[] := '{}'; a_cogs numeric[] := '{}';
  v_gross numeric := 0; v_ldisc_tot numeric := 0; v_after_tot numeric := 0; v_odisc numeric := 0;
  v_left numeric; v_net_tot numeric := 0; v_tax_tot numeric := 0; v_cogs_tot numeric := 0;
  g numeric; d numeric; v_qty numeric; v_price numeric; v_dv numeric; v_pay_acct text; r record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'The cart is empty — add at least one item.';
  end if;
  if not exists (select 1 from locations where code = p_location and sellable) then
    raise exception 'Location % is not a sellable location.', p_location;
  end if;
  if p_payment not in ('CASH','CARD','ACCOUNT','EXCHANGE_CREDIT') then
    raise exception 'Unknown payment method %', p_payment;
  end if;
  v_rate := coalesce(p_tax_rate, (select sales_tax_rate from settings where id = 1));
  n := jsonb_array_length(p_lines);

  -- pass 1: price lines + line discounts
  for i in 1..n loop
    ln := p_lines -> (i-1);
    select id, sku, name, item_type, price, avg_cost, active into it from items where id = (ln->>'item_id')::int;
    if it.id is null then raise exception 'Unknown item on line %', i; end if;
    if it.item_type = 'raw' then raise exception '% is a raw material and cannot be sold.', it.sku; end if;
    v_qty := coalesce((ln->>'qty')::numeric, 0);
    if v_qty <= 0 then raise exception 'Quantity for % must be greater than zero.', it.sku; end if;
    v_price := coalesce((ln->>'unit_price')::numeric, it.price);
    if v_price is null or v_price < 0 then raise exception '% has no selling price.', it.sku; end if;
    g := round(v_qty * v_price, 2);
    v_dv := coalesce((ln->>'disc_value')::numeric, 0);
    d := case when coalesce(ln->>'disc_type','AMT') = 'PCT' then round(g * least(greatest(v_dv,0),100) / 100, 2)
              else least(greatest(v_dv,0), g) end;
    a_item := a_item || it.id; a_qty := a_qty || v_qty; a_price := a_price || v_price;
    a_ldisc := a_ldisc || d; a_after := a_after || (g - d);
    a_cost := a_cost || it.avg_cost; a_cogs := a_cogs || round(v_qty * it.avg_cost, 2);
    v_gross := v_gross + g; v_ldisc_tot := v_ldisc_tot + d; v_after_tot := v_after_tot + (g - d);
  end loop;

  -- stock check per item at the selling location (friendly message; the ledger trigger is the hard stop)
  for r in select x.item_id, sum(x.q) q from unnest(a_item, a_qty) as x(item_id, q) group by x.item_id loop
    if app.on_hand(r.item_id, p_location) < r.q then
      raise exception 'INSUFFICIENT_STOCK: % — need %, only % on hand at %.',
        (select sku || ' ' || name from items where id = r.item_id), r.q, app.on_hand(r.item_id, p_location), p_location;
    end if;
  end loop;

  -- order-level discount, allocated across lines by value
  v_odisc := case when coalesce(p_order_disc_type,'AMT') = 'PCT'
                  then round(v_after_tot * least(greatest(coalesce(p_order_disc,0),0),100) / 100, 2)
                  else least(greatest(coalesce(p_order_disc,0),0), v_after_tot) end;
  v_left := v_odisc;
  for i in 1..n loop
    if i = n then a_alloc := a_alloc || v_left;
    else
      d := case when v_after_tot = 0 then 0 else round(v_odisc * a_after[i] / v_after_tot, 2) end;
      d := least(d, v_left); a_alloc := a_alloc || d; v_left := v_left - d;
    end if;
    a_net := a_net || (a_after[i] - a_alloc[i]);
    a_tax := a_tax || round((a_after[i] - a_alloc[i]) * v_rate, 2);
    v_net_tot := v_net_tot + a_net[i]; v_tax_tot := v_tax_tot + a_tax[i]; v_cogs_tot := v_cogs_tot + a_cogs[i];
  end loop;

  v_no := app.next_no(case when p_so_id is not null then 'INV' when p_channel = 'EXCHANGE' then 'EX' else 'R' end);
  insert into sales(receipt_no, sale_at, location_code, channel, customer_id, sales_order_id, cashier_id,
                    subtotal, line_discounts, order_discount, tax_rate, tax, total, payment_method, cogs_total, note)
  values (v_no, p_at, p_location, p_channel, p_customer, p_so_id, p_user,
          v_gross, v_ldisc_tot, v_odisc, v_rate, v_tax_tot, v_net_tot + v_tax_tot, p_payment, v_cogs_tot, p_note)
  returning id into v_sale;

  for i in 1..n loop
    insert into sale_lines(sale_id, line_no, item_id, qty, unit_price, line_discount, order_disc_alloc, net_amount, tax_amount, unit_cost)
    values (v_sale, i, a_item[i], a_qty[i], a_price[i], a_ldisc[i], a_alloc[i], a_net[i], a_tax[i], a_cost[i]);
    perform app.post_inv(a_item[i], p_location, -a_qty[i], a_cost[i], 'SALE', null, 'SALE', v_sale, v_no, p_at, p_user);
  end loop;

  -- general ledger
  v_pay_acct := case when p_payment = 'ACCOUNT' then '1100' else '1000' end;
  v_j := app.new_journal();
  perform app.gl(v_j, v_date, v_pay_acct, v_net_tot + v_tax_tot, 'SALE', v_no, 'Customer payment / receivable', p_user);
  perform app.gl(v_j, v_date, '4100', v_ldisc_tot + v_odisc, 'SALE', v_no, 'Discounts given', p_user);
  perform app.gl(v_j, v_date, '4000', -v_gross, 'SALE', v_no, 'Gross sales', p_user);
  perform app.gl(v_j, v_date, '2100', -v_tax_tot, 'SALE', v_no, 'Sales tax collected', p_user);
  perform app.gl(v_j, v_date, '5000', v_cogs_tot, 'SALE', v_no, 'Cost of goods sold (weighted avg)', p_user);
  for r in select app.inv_account(x.item_id) acct, sum(x.c) amt from unnest(a_item, a_cogs) as x(item_id, c) group by 1 loop
    perform app.gl(v_j, v_date, r.acct, -r.amt, 'SALE', v_no, 'Inventory relieved', p_user);
  end loop;
  perform app.gl_check(v_j);

  if p_payment in ('CASH','CARD') then
    insert into payments(sale_id, paid_at, method, amount) values (v_sale, p_at, p_payment, v_net_tot + v_tax_tot);
  end if;
  return v_sale;
end $$;

create or replace function public.post_sale(
  p_location text, p_lines jsonb, p_order_discount numeric default 0, p_order_discount_type text default 'AMT',
  p_payment_method text default 'CARD', p_customer_id int default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_id int; s record;
begin
  v_uid := app.require_role(array['manager','cashier']);
  if p_payment_method not in ('CASH','CARD') then raise exception 'POS payment must be CASH or CARD.'; end if;
  v_id := app._post_sale(p_location, p_lines, p_order_discount, p_order_discount_type, p_payment_method,
                         'POS', p_customer_id, now(), v_uid, null, null, p_note);
  select * into s from sales where id = v_id;
  return jsonb_build_object('sale_id', s.id, 'receipt_no', s.receipt_no, 'total', s.total, 'tax', s.tax);
end $$;

-- ---------------------------------------------------------------------
-- 4. RETURNS & EXCHANGES
-- p_lines: [{sale_line_id, qty, reason_code, disposition:'RESTOCK'|'QA_HOLD'|'SCRAP'}]
-- ---------------------------------------------------------------------
create or replace function app._process_return(p_sale_id int, p_lines jsonb, p_refund_method text, p_location text,
  p_at timestamptz, p_user uuid, p_is_exchange boolean default false, p_note text default null)
returns int language plpgsql as $$
declare
  s record; sl record; ln jsonb; v_ret int; v_no text; v_j bigint; v_date date := app.biz_date(p_at);
  v_qty numeric; v_ref numeric; v_tax numeric; v_cost numeric; v_prev_ref numeric; v_prev_tax numeric;
  v_merch numeric := 0; v_taxtot numeric := 0; v_loc text; v_disp text; v_reason text; v_acct text; i int;
begin
  select * into s from sales where id = p_sale_id;
  if s.id is null then raise exception 'Receipt not found.'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Choose at least one line to return.'; end if;
  if p_refund_method not in ('CASH','CARD','ACCOUNT','EXCHANGE') then raise exception 'Unknown refund method %', p_refund_method; end if;
  if p_refund_method = 'ACCOUNT' and s.payment_method <> 'ACCOUNT' then
    raise exception 'Refund to account is only allowed for sales charged to a wholesale account.';
  end if;
  p_location := coalesce(p_location, s.location_code);
  if not exists (select 1 from locations where code = p_location and sellable) then
    raise exception 'Returns must be received at a sellable location.';
  end if;

  v_no := app.next_no('RT');
  insert into returns(return_no, sale_id, return_at, location_code, refund_method, merchandise_amount, tax_refund,
                      refund_total, is_exchange, processed_by, note)
  values (v_no, s.id, p_at, p_location, p_refund_method, 0, 0, 0, p_is_exchange, p_user, p_note)
  returning id into v_ret;
  v_j := app.new_journal();

  for i in 0..jsonb_array_length(p_lines)-1 loop
    ln := p_lines -> i;
    select * into sl from sale_lines where id = (ln->>'sale_line_id')::int and sale_id = s.id for update;
    if sl.id is null then raise exception 'That line is not on receipt %.', s.receipt_no; end if;
    v_qty := (ln->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    if v_qty > sl.qty - sl.qty_returned then
      raise exception 'Cannot return % of % — only % left returnable on this receipt.',
        v_qty, (select sku from items where id = sl.item_id), sl.qty - sl.qty_returned;
    end if;
    v_reason := ln->>'reason_code';
    if not exists (select 1 from reason_codes where code = v_reason and category = 'RETURN') then
      raise exception 'A valid return reason code is required.';
    end if;
    v_disp := coalesce(ln->>'disposition','RESTOCK');
    if v_disp not in ('RESTOCK','QA_HOLD','SCRAP') then raise exception 'Unknown disposition %', v_disp; end if;

    select coalesce(sum(refund_amount),0), coalesce(sum(tax_refund),0) into v_prev_ref, v_prev_tax
      from return_lines where sale_line_id = sl.id;
    if v_qty = sl.qty - sl.qty_returned then           -- last units: refund exactly what is left (no rounding drift)
      v_ref := sl.net_amount - v_prev_ref; v_tax := sl.tax_amount - v_prev_tax;
    else
      v_ref := round(sl.net_amount * v_qty / sl.qty, 2); v_tax := round(sl.tax_amount * v_qty / sl.qty, 2);
    end if;
    v_cost := round(v_qty * sl.unit_cost, 2);
    v_acct := app.inv_account(sl.item_id);

    insert into return_lines(return_id, sale_line_id, item_id, qty, reason_code, disposition, refund_amount, tax_refund, unit_cost)
    values (v_ret, sl.id, sl.item_id, v_qty, v_reason, v_disp, v_ref, v_tax, sl.unit_cost);
    update sale_lines set qty_returned = qty_returned + v_qty where id = sl.id;

    if v_disp = 'SCRAP' then
      -- goes to QA Hold and is written off immediately; cost moves from COGS to write-off expense
      perform app.post_inv(sl.item_id, 'QAH', v_qty, sl.unit_cost, 'RETURN', v_reason, 'RETURN', v_ret, v_no, p_at, p_user, 'Returned - scrapped');
      perform app.post_inv(sl.item_id, 'QAH', -v_qty, sl.unit_cost, 'SCRAP', v_reason, 'RETURN', v_ret, v_no, p_at, p_user, 'Return scrapped');
      perform app.gl(v_j, v_date, '5100', v_cost, 'RETURN', v_no, 'Returned goods scrapped', p_user);
      perform app.gl(v_j, v_date, '5000', -v_cost, 'RETURN', v_no, 'Reverse COGS', p_user);
    else
      v_loc := case when v_disp = 'QA_HOLD' then 'QAH' else p_location end;
      perform app.receive_cost(sl.item_id, v_qty, sl.unit_cost);   -- back in at ORIGINAL cost
      perform app.post_inv(sl.item_id, v_loc, v_qty, sl.unit_cost, 'RETURN', v_reason, 'RETURN', v_ret, v_no, p_at, p_user,
                           case when v_disp = 'QA_HOLD' then 'Awaiting QA inspection' else 'Restocked' end);
      perform app.gl(v_j, v_date, v_acct, v_cost, 'RETURN', v_no, 'Returned goods to inventory', p_user);
      perform app.gl(v_j, v_date, '5000', -v_cost, 'RETURN', v_no, 'Reverse COGS', p_user);
    end if;
    v_merch := v_merch + v_ref; v_taxtot := v_taxtot + v_tax;
  end loop;

  if v_merch + v_taxtot = 0 and not exists (select 1 from return_lines where return_id = v_ret) then
    raise exception 'Nothing was selected to return.';
  end if;
  update returns set merchandise_amount = v_merch, tax_refund = v_taxtot, refund_total = v_merch + v_taxtot where id = v_ret;

  perform app.gl(v_j, v_date, '4200', v_merch, 'RETURN', v_no, 'Sales returns & allowances', p_user);
  perform app.gl(v_j, v_date, '2100', v_taxtot, 'RETURN', v_no, 'Sales tax refunded', p_user);
  perform app.gl(v_j, v_date, case when p_refund_method = 'ACCOUNT' then '1100' else '1000' end,
                 -(v_merch + v_taxtot), 'RETURN', v_no, 'Refund', p_user);
  perform app.gl_check(v_j);

  if p_refund_method = 'ACCOUNT' then
    update ar_invoices set amount = amount - (v_merch + v_taxtot),
           status = case when amount_paid >= amount - (v_merch + v_taxtot) then 'PAID' else 'OPEN' end
     where sale_id = s.id;
  elsif p_refund_method in ('CASH','CARD') then
    insert into payments(sale_id, return_id, paid_at, method, amount) values (s.id, v_ret, p_at, p_refund_method, -(v_merch + v_taxtot));
  end if;
  return v_ret;
end $$;

create or replace function public.process_return(p_sale_id int, p_lines jsonb, p_refund_method text default 'CARD',
  p_location text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_id int; r record;
begin
  v_uid := app.require_role(array['manager','cashier']);
  v_id := app._process_return(p_sale_id, p_lines, p_refund_method, p_location, now(), v_uid, false, p_note);
  select * into r from returns where id = v_id;
  return jsonb_build_object('return_id', r.id, 'return_no', r.return_no, 'refund_total', r.refund_total);
end $$;

create or replace function app._process_exchange(p_sale_id int, p_return_lines jsonb, p_new_lines jsonb, p_location text,
  p_payment_method text, p_at timestamptz, p_user uuid)
returns int language plpgsql as $$
declare v_ret int; v_new int; v_diff numeric; s record; v_loc text;
begin
  select * into s from sales where id = p_sale_id;
  if s.id is null then raise exception 'Receipt not found.'; end if;
  if p_new_lines is null or jsonb_array_length(p_new_lines) = 0 then raise exception 'Add the replacement item(s) for the exchange.'; end if;
  v_loc := coalesce(p_location, s.location_code);
  v_ret := app._process_return(p_sale_id, p_return_lines, 'EXCHANGE', v_loc, p_at, p_user, true, 'Exchange');
  v_new := app._post_sale(v_loc, p_new_lines, 0, 'AMT', 'EXCHANGE_CREDIT', 'EXCHANGE', s.customer_id, p_at, p_user,
                          null, s.tax_rate, 'Exchange for ' || s.receipt_no);
  v_diff := (select total from sales where id = v_new) - (select refund_total from returns where id = v_ret);
  insert into exchanges(return_id, new_sale_id, price_difference, created_at) values (v_ret, v_new, v_diff, p_at);
  if v_diff <> 0 then
    if coalesce(p_payment_method,'CARD') not in ('CASH','CARD') then raise exception 'Exchange difference must be settled by CASH or CARD.'; end if;
    insert into payments(sale_id, return_id, paid_at, method, amount) values (v_new, v_ret, p_at, coalesce(p_payment_method,'CARD'), v_diff);
  end if;
  return v_new;
end $$;

create or replace function public.process_exchange(p_sale_id int, p_return_lines jsonb, p_new_lines jsonb,
  p_location text default null, p_payment_method text default 'CARD')
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_new int; x record;
begin
  v_uid := app.require_role(array['manager','cashier']);
  v_new := app._process_exchange(p_sale_id, p_return_lines, p_new_lines, p_location, p_payment_method, now(), v_uid);
  select e.price_difference, r.return_no, s.receipt_no, s.id sale_id into x
    from exchanges e join returns r on r.id = e.return_id join sales s on s.id = e.new_sale_id where e.new_sale_id = v_new;
  return jsonb_build_object('new_sale_id', x.sale_id, 'receipt_no', x.receipt_no, 'return_no', x.return_no,
                            'price_difference', x.price_difference);
end $$;

-- ---------------------------------------------------------------------
-- 5. TRANSFERS, ADJUSTMENTS, CYCLE COUNTS
-- ---------------------------------------------------------------------
create or replace function app._transfer(p_item int, p_from text, p_to text, p_qty numeric, p_note text,
  p_at timestamptz, p_user uuid) returns text language plpgsql as $$
declare v_no text; it record;
begin
  select * into it from items where id = p_item;
  if it.id is null then raise exception 'Unknown item.'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Transfer quantity must be greater than zero.'; end if;
  if p_from = p_to then raise exception 'From and To locations must be different.'; end if;
  if p_to = 'STR' and it.item_type = 'raw' then raise exception 'The Storefront holds finished goods only — % is a raw material.', it.sku; end if;
  if app.on_hand(p_item, p_from) < p_qty then
    raise exception 'INSUFFICIENT_STOCK: only % of % on hand at %.', app.on_hand(p_item, p_from), it.sku, p_from;
  end if;
  v_no := app.next_no('TR');
  perform app.post_inv(p_item, p_from, -p_qty, it.avg_cost, 'TRANSFER_OUT', null, 'TRANSFER', null, v_no, p_at, p_user, p_note);
  perform app.post_inv(p_item, p_to,    p_qty, it.avg_cost, 'TRANSFER_IN',  null, 'TRANSFER', null, v_no, p_at, p_user, p_note);
  return v_no;   -- no GL entry: both locations roll up to the same inventory account
end $$;

create or replace function public.transfer_inventory(p_item_id int, p_from text, p_to text, p_qty numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid;
begin
  v_uid := app.require_role(array['manager','cashier','production']);
  return jsonb_build_object('transfer_no', app._transfer(p_item_id, p_from, p_to, p_qty, p_note, now(), v_uid));
end $$;

create or replace function app._adjust(p_item int, p_loc text, p_qty numeric, p_reason text, p_note text,
  p_at timestamptz, p_user uuid, p_type text default 'ADJUSTMENT') returns text language plpgsql as $$
declare v_no text; it record; rc record; v_amt numeric; v_j bigint; v_date date := app.biz_date(p_at);
begin
  select * into it from items where id = p_item;
  if it.id is null then raise exception 'Unknown item.'; end if;
  select * into rc from reason_codes where code = p_reason and category in ('ADJUST','SCRAP');
  if rc.code is null then raise exception 'A valid adjustment reason code is required.'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'Adjustment quantity cannot be zero.'; end if;
  if p_qty < 0 and app.on_hand(p_item, p_loc) < -p_qty then
    raise exception 'INSUFFICIENT_STOCK: cannot remove % — only % of % on hand at %.', -p_qty, app.on_hand(p_item,p_loc), it.sku, p_loc;
  end if;
  v_no := app.next_no('ADJ');
  perform app.post_inv(p_item, p_loc, p_qty, it.avg_cost, p_type, p_reason, 'ADJUSTMENT', null, v_no, p_at, p_user, p_note);
  v_amt := round(abs(p_qty) * it.avg_cost, 2);
  v_j := app.new_journal();
  if p_qty > 0 then
    perform app.gl(v_j, v_date, app.inv_account(p_item), v_amt, 'ADJUSTMENT', v_no, rc.description, p_user);
    perform app.gl(v_j, v_date, coalesce(rc.gl_account,'5200'), -v_amt, 'ADJUSTMENT', v_no, rc.description, p_user);
  else
    perform app.gl(v_j, v_date, coalesce(rc.gl_account,'5200'), v_amt, 'ADJUSTMENT', v_no, rc.description, p_user);
    perform app.gl(v_j, v_date, app.inv_account(p_item), -v_amt, 'ADJUSTMENT', v_no, rc.description, p_user);
  end if;
  perform app.gl_check(v_j);
  return v_no;
end $$;

create or replace function public.adjust_inventory(p_item_id int, p_location text, p_qty_change numeric, p_reason_code text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_no text;
begin
  v_uid := app.require_role(array['manager','cashier','production']);
  v_no := app._adjust(p_item_id, p_location, p_qty_change, p_reason_code, p_note, now(), v_uid,
                      case when p_reason_code = 'CYCLE_COUNT' then 'CYCLE_COUNT' else 'ADJUSTMENT' end);
  return jsonb_build_object('adjustment_no', v_no, 'new_on_hand', app.on_hand(p_item_id, p_location));
end $$;

create or replace function public.cycle_count(p_item_id int, p_location text, p_counted_qty numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_sys numeric; v_var numeric; v_no text; v_cost numeric;
begin
  v_uid := app.require_role(array['manager','cashier','production']);
  if p_counted_qty is null or p_counted_qty < 0 then raise exception 'Counted quantity must be zero or more.'; end if;
  v_sys := app.on_hand(p_item_id, p_location);
  v_var := p_counted_qty - v_sys;
  select avg_cost into v_cost from items where id = p_item_id;
  if v_var <> 0 then
    v_no := app._adjust(p_item_id, p_location, v_var, 'CYCLE_COUNT', coalesce(p_note, 'Cycle count'), now(), v_uid, 'CYCLE_COUNT');
  end if;
  return jsonb_build_object('system_qty', v_sys, 'counted_qty', p_counted_qty, 'variance', v_var,
                            'variance_value', round(v_var * v_cost, 2), 'adjustment_no', v_no);
end $$;

-- ---------------------------------------------------------------------
-- 6. SALES ORDERS (wholesale, phone, and customer pickup orders)
-- ---------------------------------------------------------------------
create or replace function app._create_so(p_customer int, p_channel text, p_location text, p_requested date,
  p_lines jsonb, p_notes text, p_at timestamptz, p_user uuid) returns int language plpgsql as $$
declare v_id int; v_no text; c record; ln jsonb; it record; i int; v_price numeric; v_pct numeric;
begin
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found.'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item to the order.'; end if;
  if not exists (select 1 from locations where code = p_location and sellable) then raise exception 'Choose a valid pickup / fulfillment location.'; end if;
  if p_requested is null then raise exception 'Requested date is required.'; end if;
  select wholesale_price_pct into v_pct from settings where id = 1;
  v_no := app.next_no('SO');
  insert into sales_orders(so_no, customer_id, channel, location_code, order_date, requested_date, notes, created_by, created_at)
  values (v_no, c.id, p_channel, p_location, app.biz_date(p_at), p_requested, p_notes, p_user, p_at) returning id into v_id;
  for i in 0..jsonb_array_length(p_lines)-1 loop
    ln := p_lines -> i;
    select * into it from items where id = (ln->>'item_id')::int and active and item_type <> 'raw';
    if it.id is null then raise exception 'Line % is not a sellable item.', i+1; end if;
    if coalesce((ln->>'qty')::numeric,0) <= 0 then raise exception 'Quantity for % must be greater than zero.', it.sku; end if;
    v_price := case when c.customer_type = 'wholesale' then round(it.price * v_pct, 2) else it.price end;
    if (ln ? 'unit_price') and app.my_role() is distinct from 'customer' then v_price := (ln->>'unit_price')::numeric; end if;
    insert into so_lines(so_id, line_no, item_id, qty_ordered, unit_price, discount_pct)
    values (v_id, i+1, it.id, (ln->>'qty')::numeric, v_price, coalesce((ln->>'discount_pct')::numeric, 0));
  end loop;
  return v_id;
end $$;

create or replace function public.create_sales_order(p_customer_id int, p_location text, p_requested_date date,
  p_lines jsonb, p_channel text default 'PHONE', p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := auth.uid(); v_role text := app.my_role(); v_cust int; v_id int; v_channel text;
begin
  if v_role = 'customer' then
    v_cust := app.my_customer_id();
    if v_cust is null then raise exception 'Your login is not linked to a customer account.'; end if;
    v_channel := 'ONLINE_PICKUP';
    if p_requested_date < app.today() then raise exception 'Pickup date cannot be in the past.'; end if;
  else
    v_uid := app.require_role(array['manager','cashier']);
    v_cust := p_customer_id;
    v_channel := coalesce(p_channel, 'PHONE');
    if (select customer_type from customers where id = v_cust) = 'wholesale' then v_channel := 'WHOLESALE'; end if;
  end if;
  v_id := app._create_so(v_cust, v_channel, p_location, p_requested_date, p_lines, p_notes, now(), v_uid);
  return jsonb_build_object('so_id', v_id, 'so_no', (select so_no from sales_orders where id = v_id));
end $$;

-- p_lines: optional [{so_line_id, qty}] — default ships everything available at the SO location
create or replace function app._fulfill_so(p_so_id int, p_lines jsonb, p_payment text, p_at timestamptz, p_user uuid)
returns int language plpgsql as $$
declare so record; c record; l record; v_want numeric; v_avail numeric; v_q numeric; v_sale_lines jsonb := '[]';
  v_upd jsonb := '[]'; v_sale int; v_pay text; v_tax numeric; u jsonb; v_left numeric; v_inv text;
begin
  select * into so from sales_orders where id = p_so_id for update;
  if so.id is null then raise exception 'Sales order not found.'; end if;
  if so.status not in ('ORDER_PLACED','PARTIALLY_FULFILLED') then raise exception 'Order % is % and cannot be fulfilled.', so.so_no, so.status; end if;
  select * into c from customers where id = so.customer_id;
  for l in select sl.*, i.sku from so_lines sl join items i on i.id = sl.item_id where so_id = so.id order by line_no loop
    v_left := l.qty_ordered - l.qty_fulfilled;
    if v_left <= 0 then continue; end if;
    if p_lines is null then v_want := v_left;
    else
      select (x->>'qty')::numeric into v_want from jsonb_array_elements(p_lines) x where (x->>'so_line_id')::int = l.id;
      v_want := coalesce(v_want, 0);
      if v_want > v_left then raise exception 'Cannot ship % of % — only % remain on the order.', v_want, l.sku, v_left; end if;
    end if;
    v_avail := app.on_hand(l.item_id, so.location_code);
    if p_lines is not null and v_want > v_avail then
      raise exception 'INSUFFICIENT_STOCK: % — want %, only % at %.', l.sku, v_want, v_avail, so.location_code;
    end if;
    v_q := least(v_want, v_avail);
    if v_q > 0 then
      v_sale_lines := v_sale_lines || jsonb_build_object('item_id', l.item_id, 'qty', v_q, 'unit_price', l.unit_price,
                                                          'disc_type', 'PCT', 'disc_value', l.discount_pct);
      v_upd := v_upd || jsonb_build_object('id', l.id, 'q', v_q);
    end if;
  end loop;
  if jsonb_array_length(v_sale_lines) = 0 then
    raise exception 'Nothing on hand at % to ship for %. Transfer stock in, or leave it on backorder.', so.location_code, so.so_no;
  end if;
  v_pay := case when c.customer_type = 'wholesale' then 'ACCOUNT' else coalesce(p_payment, 'CARD') end;
  v_tax := case when c.customer_type = 'wholesale' then 0 else null end;     -- wholesale is resale-exempt
  v_sale := app._post_sale(so.location_code, v_sale_lines, 0, 'AMT', v_pay, so.channel, so.customer_id, p_at, p_user,
                           so.id, v_tax, 'Sales order ' || so.so_no);
  for u in select * from jsonb_array_elements(v_upd) loop
    update so_lines set qty_fulfilled = qty_fulfilled + (u->>'q')::numeric where id = (u->>'id')::int;
  end loop;
  update so_lines set backordered = (qty_ordered > qty_fulfilled) where so_id = so.id;
  update sales_orders set status = case when exists (select 1 from so_lines where so_id = so.id and qty_fulfilled < qty_ordered)
                                        then 'PARTIALLY_FULFILLED' else 'FULFILLED' end,
                          updated_at = p_at
   where id = so.id;
  if v_pay = 'ACCOUNT' then
    select receipt_no into v_inv from sales where id = v_sale;
    insert into ar_invoices(invoice_no, customer_id, sale_id, invoice_date, due_date, amount)
    values (v_inv, c.id, v_sale, app.biz_date(p_at), app.biz_date(p_at) + greatest(c.terms_days, 0),
            (select total from sales where id = v_sale));
  end if;
  return v_sale;
end $$;

create or replace function public.fulfill_sales_order(p_so_id int, p_lines jsonb default null, p_payment_method text default 'CARD')
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_sale int; s record;
begin
  v_uid := app.require_role(array['manager','cashier']);
  v_sale := app._fulfill_so(p_so_id, p_lines, p_payment_method, now(), v_uid);
  select * into s from sales where id = v_sale;
  return jsonb_build_object('sale_id', s.id, 'invoice_no', s.receipt_no, 'total', s.total,
                            'status', (select status from sales_orders where id = p_so_id));
end $$;

create or replace function public.close_sales_order(p_so_id int)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare so record;
begin
  perform app.require_role(array['manager','cashier']);
  select * into so from sales_orders where id = p_so_id for update;
  if so.status not in ('FULFILLED','PARTIALLY_FULFILLED') then raise exception 'Only fulfilled orders can be closed (order is %).', so.status; end if;
  update so_lines set backordered = false where so_id = so.id;
  update sales_orders set status = 'CLOSED', updated_at = now() where id = so.id;
  return jsonb_build_object('so_no', so.so_no, 'status', 'CLOSED');
end $$;

create or replace function public.cancel_sales_order(p_so_id int, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare so record; v_role text := app.my_role();
begin
  select * into so from sales_orders where id = p_so_id for update;
  if so.id is null then raise exception 'Order not found.'; end if;
  if v_role = 'customer' then
    if so.customer_id is distinct from app.my_customer_id() then raise exception 'Order not found.'; end if;
  else
    perform app.require_role(array['manager','cashier']);
  end if;
  if so.status <> 'ORDER_PLACED' or exists (select 1 from so_lines where so_id = so.id and qty_fulfilled > 0) then
    raise exception 'Only orders that have not shipped can be cancelled.';
  end if;
  update sales_orders set status = 'CANCELLED', notes = concat_ws(' | ', notes, 'Cancelled: ' || p_reason), updated_at = now() where id = so.id;
  return jsonb_build_object('so_no', so.so_no, 'status', 'CANCELLED');
end $$;

create or replace function app._ar_payment(p_invoice int, p_amount numeric, p_date date, p_user uuid) returns void
language plpgsql as $$
declare inv record; v_j bigint;
begin
  select * into inv from ar_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'Invoice not found.'; end if;
  if p_amount <= 0 or p_amount > inv.amount - inv.amount_paid + 0.001 then
    raise exception 'Payment must be between $0.01 and the open balance ($%).', inv.amount - inv.amount_paid;
  end if;
  insert into ar_payments(invoice_id, paid_date, amount, created_by) values (inv.id, p_date, p_amount, p_user);
  update ar_invoices set amount_paid = amount_paid + p_amount,
         status = case when amount_paid + p_amount >= amount then 'PAID' else 'OPEN' end where id = inv.id;
  v_j := app.new_journal();
  perform app.gl(v_j, p_date, '1000', p_amount, 'AR_PAYMENT', inv.invoice_no, 'Customer payment received', p_user);
  perform app.gl(v_j, p_date, '1100', -p_amount, 'AR_PAYMENT', inv.invoice_no, 'Customer payment received', p_user);
  perform app.gl_check(v_j);
end $$;

create or replace function public.record_customer_payment(p_invoice_id int, p_amount numeric, p_paid_date date default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid;
begin
  v_uid := app.require_role(array['manager']);
  perform app._ar_payment(p_invoice_id, p_amount, coalesce(p_paid_date, app.today()), v_uid);
  return (select to_jsonb(a) from ar_invoices a where id = p_invoice_id);
end $$;

-- ---------------------------------------------------------------------
-- 7. PURCHASING
-- ---------------------------------------------------------------------
-- p_lines: [{item_id, qty, unit_cost?}]
create or replace function app._create_po(p_supplier int, p_ship_to text, p_lines jsonb, p_order_date date,
  p_notes text, p_user uuid) returns int language plpgsql as $$
declare v_id int; v_no text; sup record; ln jsonb; i int; v_cost numeric; v_item int;
begin
  select * into sup from suppliers where id = p_supplier;
  if sup.id is null then raise exception 'Supplier not found.'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one line to the PO.'; end if;
  if not exists (select 1 from locations where code = p_ship_to and code <> 'QAH') then raise exception 'Choose a receiving location.'; end if;
  v_no := app.next_no('PO');
  insert into purchase_orders(po_no, supplier_id, ship_to, order_date, expected_date, notes, created_by, created_at)
  values (v_no, sup.id, p_ship_to, p_order_date, p_order_date + sup.quoted_lead_days, p_notes, p_user, app.day_start(p_order_date) + interval '10 hours')
  returning id into v_id;
  for i in 0..jsonb_array_length(p_lines)-1 loop
    ln := p_lines -> i;
    v_item := (ln->>'item_id')::int;
    if not exists (select 1 from items where id = v_item and item_type in ('raw','resale')) then
      raise exception 'Line %: only purchased items (raw materials / resale) go on a PO.', i+1;
    end if;
    if coalesce((ln->>'qty')::numeric,0) <= 0 then raise exception 'Line %: quantity must be greater than zero.', i+1; end if;
    v_cost := coalesce((ln->>'unit_cost')::numeric,
                       (select unit_cost from supplier_items where supplier_id = sup.id and item_id = v_item),
                       (select coalesce(nullif(avg_cost,0), std_cost) from items where id = v_item));
    insert into po_lines(po_id, line_no, item_id, qty_ordered, unit_cost) values (v_id, i+1, v_item, (ln->>'qty')::numeric, v_cost);
  end loop;
  return v_id;
end $$;

create or replace function public.create_purchase_order(p_supplier_id int, p_ship_to text, p_lines jsonb,
  p_order_date date default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_id int;
begin
  v_uid := app.require_role(array['manager']);
  v_id := app._create_po(p_supplier_id, p_ship_to, p_lines, coalesce(p_order_date, app.today()), p_notes, v_uid);
  return (select jsonb_build_object('po_id', id, 'po_no', po_no, 'expected_date', expected_date) from purchase_orders where id = v_id);
end $$;

-- p_lines: [{po_line_id | item_id, qty}]
create or replace function app._receive_po(p_po int, p_location text, p_lines jsonb, p_date date, p_user uuid)
returns int language plpgsql as $$
declare po record; sup record; v_rec int; v_no text; ln jsonb; pl record; v_qty numeric; v_total numeric := 0;
  v_j bigint; v_at timestamptz := app.day_start(p_date) + interval '11 hours'; i int; v_due int; r record;
begin
  select * into po from purchase_orders where id = p_po for update;
  if po.id is null then raise exception 'Purchase order not found.'; end if;
  if po.status not in ('ORDER_SENT','PARTIALLY_RECEIVED') then raise exception 'PO % is % — nothing left to receive.', po.po_no, po.status; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Enter at least one received quantity.'; end if;
  p_location := coalesce(p_location, po.ship_to);
  if p_location = 'QAH' or not exists (select 1 from locations where code = p_location) then raise exception 'Invalid receiving location.'; end if;
  if p_date > app.today() then raise exception 'Receipt date cannot be in the future.'; end if;
  select * into sup from suppliers where id = po.supplier_id;
  v_no := app.next_no('RCV');
  insert into po_receipts(receipt_no, po_id, received_date, location_code, days_late, received_by, created_at)
  values (v_no, po.id, p_date, p_location, p_date - po.expected_date, p_user, v_at) returning id into v_rec;
  v_j := app.new_journal();
  for i in 0..jsonb_array_length(p_lines)-1 loop
    ln := p_lines -> i;
    v_qty := coalesce((ln->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into pl from po_lines where po_id = po.id
       and (id = (ln->>'po_line_id')::int or ((ln->>'po_line_id') is null and item_id = (ln->>'item_id')::int))
     order by (qty_ordered - qty_received) desc limit 1 for update;
    if pl.id is null then raise exception 'Item on line % is not on PO %.', i+1, po.po_no; end if;
    if pl.qty_received + v_qty > pl.qty_ordered * 1.10 then
      raise exception 'Over-receipt: % ordered, % already received — cannot accept %.', pl.qty_ordered, pl.qty_received, v_qty;
    end if;
    insert into receipt_lines(receipt_id, po_line_id, item_id, qty, unit_cost) values (v_rec, pl.id, pl.item_id, v_qty, pl.unit_cost);
    update po_lines set qty_received = qty_received + v_qty where id = pl.id;
    perform app.receive_cost(pl.item_id, v_qty, pl.unit_cost);
    perform app.post_inv(pl.item_id, p_location, v_qty, pl.unit_cost, 'PO_RECEIPT', null, 'PO_RECEIPT', v_rec, v_no, v_at, p_user, po.po_no);
    v_total := v_total + round(v_qty * pl.unit_cost, 2);
  end loop;
  if v_total = 0 then raise exception 'Enter at least one received quantity.'; end if;
  for r in select app.inv_account(item_id) acct, sum(round(qty*unit_cost,2)) amt from receipt_lines where receipt_id = v_rec group by 1 loop
    perform app.gl(v_j, p_date, r.acct, r.amt, 'PO_RECEIPT', v_no, 'Received ' || po.po_no, p_user);
  end loop;
  perform app.gl(v_j, p_date, '2000', -v_total, 'PO_RECEIPT', v_no, 'Supplier invoice ' || sup.name, p_user);
  perform app.gl_check(v_j);
  update purchase_orders set status = case when exists (select 1 from po_lines where po_id = po.id and qty_received < qty_ordered)
                                           then 'PARTIALLY_RECEIVED' else 'RECEIVED' end where id = po.id;
  v_due := app.terms_days(sup.payment_terms);
  insert into ap_invoices(invoice_no, supplier_id, po_id, receipt_id, invoice_date, due_date, discount_date, discount_pct, amount)
  values ('AP-' || v_no, sup.id, po.id, v_rec, p_date, p_date + v_due,
          case when sup.payment_terms = '2/10 Net 30' then p_date + 10 end,
          case when sup.payment_terms = '2/10 Net 30' then 2 else 0 end, v_total);
  return v_rec;
end $$;

create or replace function public.receive_purchase_order(p_po_id int, p_location text, p_lines jsonb, p_received_date date default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_id int;
begin
  v_uid := app.require_role(array['manager','production']);
  v_id := app._receive_po(p_po_id, p_location, p_lines, coalesce(p_received_date, app.today()), v_uid);
  return (select jsonb_build_object('receipt_id', r.id, 'receipt_no', r.receipt_no, 'days_late', r.days_late,
                 'po_status', p.status, 'invoice_no', 'AP-' || r.receipt_no)
            from po_receipts r join purchase_orders p on p.id = r.po_id where r.id = v_id);
end $$;

create or replace function public.close_purchase_order(p_po_id int)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare po record;
begin
  perform app.require_role(array['manager']);
  select * into po from purchase_orders where id = p_po_id for update;
  if po.status not in ('RECEIVED','PARTIALLY_RECEIVED','ORDER_SENT') then raise exception 'PO % is already %.', po.po_no, po.status; end if;
  update purchase_orders set status = case when exists (select 1 from po_receipts where po_id = po.id) then 'CLOSED' else 'CANCELLED' end
   where id = po.id;
  return (select jsonb_build_object('po_no', po_no, 'status', status) from purchase_orders where id = po.id);
end $$;

create or replace function app._pay_ap(p_invoice int, p_amount numeric, p_date date, p_take_discount boolean, p_user uuid)
returns void language plpgsql as $$
declare inv record; v_disc numeric := 0; v_j bigint; v_open numeric;
begin
  select * into inv from ap_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'Invoice not found.'; end if;
  v_open := inv.amount - inv.amount_paid;
  if v_open <= 0 then raise exception 'Invoice % is already paid.', inv.invoice_no; end if;
  if p_take_discount and inv.discount_pct > 0 and p_date <= inv.discount_date and inv.amount_paid = 0 then
    v_disc := round(inv.amount * inv.discount_pct / 100, 2);
    p_amount := inv.amount - v_disc;
  end if;
  p_amount := coalesce(p_amount, v_open - v_disc);
  if p_amount <= 0 or p_amount + v_disc > v_open + 0.001 then raise exception 'Payment must be between $0.01 and the open balance ($%).', v_open; end if;
  insert into ap_payments(invoice_id, paid_date, amount, discount_taken, created_by) values (inv.id, p_date, p_amount, v_disc, p_user);
  update ap_invoices set amount_paid = amount_paid + p_amount + v_disc,
         status = case when amount_paid + p_amount + v_disc >= amount then 'PAID' else 'OPEN' end where id = inv.id;
  v_j := app.new_journal();
  perform app.gl(v_j, p_date, '2000', p_amount + v_disc, 'AP_PAYMENT', inv.invoice_no, 'Supplier payment', p_user);
  perform app.gl(v_j, p_date, '1000', -p_amount, 'AP_PAYMENT', inv.invoice_no, 'Supplier payment', p_user);
  perform app.gl(v_j, p_date, '7000', -v_disc, 'AP_PAYMENT', inv.invoice_no, 'Early-payment discount', p_user);
  perform app.gl_check(v_j);
end $$;

create or replace function public.record_supplier_payment(p_invoice_id int, p_amount numeric default null,
  p_paid_date date default null, p_take_discount boolean default true)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid;
begin
  v_uid := app.require_role(array['manager']);
  perform app._pay_ap(p_invoice_id, p_amount, coalesce(p_paid_date, app.today()), p_take_discount, v_uid);
  return (select to_jsonb(a) from ap_invoices a where id = p_invoice_id);
end $$;

-- ---------------------------------------------------------------------
-- 8. PRODUCTION
-- ---------------------------------------------------------------------
create or replace function app._create_mo(p_item int, p_qty numeric, p_loc text, p_start timestamptz, p_finish timestamptz,
  p_user uuid, p_notes text default null) returns int language plpgsql as $$
declare it record; v_id int;
begin
  select * into it from items where id = p_item;
  if it.id is null or it.item_type not in ('finished','kit') then raise exception 'Production orders are only for made items (candles, soaps, tins, gift sets).'; end if;
  if not exists (select 1 from bom_lines where parent_id = p_item) then raise exception '% has no bill of materials.', it.sku; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero.'; end if;
  if p_loc not in ('WKS','WHS') then raise exception 'Production runs at the Workshop (or kit assembly at the Warehouse).'; end if;
  p_start := coalesce(p_start, now());
  p_finish := coalesce(p_finish, p_start + make_interval(days => greatest(it.lead_time_days,1)));
  if p_finish < p_start then raise exception 'Planned finish must be after planned start.'; end if;
  insert into production_orders(mo_no, item_id, location_code, qty_planned, planned_start, planned_finish, notes, created_by, created_at)
  values (app.next_no('MO'), p_item, p_loc, p_qty, p_start, p_finish, p_notes, p_user, least(p_start, now()))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.create_production_order(p_item_id int, p_qty numeric, p_location text default 'WKS',
  p_planned_start timestamptz default null, p_planned_finish timestamptz default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_id int;
begin
  v_uid := app.require_role(array['manager','production']);
  v_id := app._create_mo(p_item_id, p_qty, p_location, p_planned_start, p_planned_finish, v_uid, p_notes);
  return (select jsonb_build_object('mo_id', id, 'mo_no', mo_no) from production_orders where id = v_id);
end $$;

-- Component requirements vs availability for a production order
create or replace function app.mo_shortages(p_mo int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('item_id', c.id, 'sku', c.sku, 'name', c.name, 'uom', c.uom,
           'needed', round(mo.qty_planned * b.qty_per, 4),
           'on_hand', app.on_hand(c.id, mo.location_code),
           'short', round(mo.qty_planned * b.qty_per - app.on_hand(c.id, mo.location_code), 4)) order by c.sku), '[]')
  from production_orders mo join bom_lines b on b.parent_id = mo.item_id join items c on c.id = b.component_id
  where mo.id = p_mo and app.on_hand(c.id, mo.location_code) < round(mo.qty_planned * b.qty_per, 4)
$$;

create or replace function app._issue_mo(p_mo int, p_at timestamptz, p_user uuid) returns void language plpgsql as $$
declare mo record; b record; v_need numeric; v_cost numeric := 0; v_j bigint; v_date date := app.biz_date(p_at);
  v_short jsonb; v_flot text; v_lot text;
begin
  select * into mo from production_orders where id = p_mo for update;
  if mo.id is null then raise exception 'Production order not found.'; end if;
  if mo.status <> 'PLANNED' then raise exception 'Order % is already %.', mo.mo_no, mo.status; end if;
  v_short := app.mo_shortages(p_mo);
  if jsonb_array_length(v_short) > 0 then
    raise exception 'SHORT_COMPONENTS:%', v_short::text;
  end if;
  v_j := app.new_journal();
  for b in select bl.component_id, bl.qty_per, i.avg_cost, i.category, i.sku from bom_lines bl join items i on i.id = bl.component_id
            where bl.parent_id = mo.item_id loop
    v_need := round(mo.qty_planned * b.qty_per, 4);
    perform app.post_inv(b.component_id, mo.location_code, -v_need, b.avg_cost, 'PROD_ISSUE', null, 'PRODUCTION', mo.id, mo.mo_no, p_at, p_user);
    perform app.gl(v_j, v_date, app.inv_account(b.component_id), -round(v_need * b.avg_cost, 2), 'PROD_ISSUE', mo.mo_no, 'Issue ' || b.sku, p_user);
    v_cost := v_cost + round(v_need * b.avg_cost, 2);
    if b.category = 'fragrance' and v_flot is null then
      select r.receipt_no into v_flot from receipt_lines rl join po_receipts r on r.id = rl.receipt_id
       where rl.item_id = b.component_id and r.received_date <= v_date order by r.received_date desc, r.id desc limit 1;
      v_flot := coalesce('FO-' || v_flot, 'FO-OPENING');
    end if;
  end loop;
  perform app.gl(v_j, v_date, '1250', v_cost, 'PROD_ISSUE', mo.mo_no, 'Materials to work in process', p_user);
  perform app.gl_check(v_j);
  v_lot := 'LOT-' || to_char(p_at at time zone 'America/Denver', 'YYMMDD') || '-' || mo.id;
  update production_orders set status = 'IN_PROGRESS', actual_start = p_at, qty_started = qty_planned,
         component_cost = v_cost, lot_no = v_lot, fragrance_lot = v_flot where id = mo.id;
end $$;

create or replace function public.issue_production_order(p_mo_id int)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid;
begin
  v_uid := app.require_role(array['manager','production']);
  perform app._issue_mo(p_mo_id, now(), v_uid);
  return (select jsonb_build_object('mo_no', mo_no, 'status', status, 'component_cost', component_cost, 'lot_no', lot_no)
            from production_orders where id = p_mo_id);
end $$;

create or replace function app._complete_mo(p_mo int, p_good numeric, p_scrap numeric, p_reason text,
  p_start timestamptz, p_finish timestamptz, p_user uuid) returns void language plpgsql as $$
declare mo record; it record; v_unit numeric; v_j bigint; v_date date; v_cure int;
begin
  select * into mo from production_orders where id = p_mo for update;
  if mo.id is null then raise exception 'Production order not found.'; end if;
  if mo.status <> 'IN_PROGRESS' then raise exception 'Order % must be issued (In Progress) before it can be completed.', mo.mo_no; end if;
  p_good := coalesce(p_good,0); p_scrap := coalesce(p_scrap,0);
  if p_good < 0 or p_scrap < 0 then raise exception 'Quantities cannot be negative.'; end if;
  if p_good + p_scrap <> mo.qty_started then
    raise exception 'Good (%) + scrapped (%) must equal the quantity started (%).', p_good, p_scrap, mo.qty_started;
  end if;
  if p_scrap > 0 and (p_reason is null or not exists (select 1 from reason_codes where code = p_reason and category = 'SCRAP')) then
    raise exception 'Choose a scrap reason code for the % scrapped units.', p_scrap;
  end if;
  p_start := coalesce(p_start, mo.actual_start); p_finish := coalesce(p_finish, now());
  if p_finish <= p_start then raise exception 'Actual finish must be after actual start.'; end if;
  select * into it from items where id = mo.item_id;
  v_date := app.biz_date(p_finish);
  v_j := app.new_journal();
  if p_good > 0 then
    v_unit := round(mo.component_cost / p_good, 4);              -- scrap cost is absorbed by good units
    perform app.receive_cost(mo.item_id, p_good, v_unit);
    perform app.post_inv(mo.item_id, mo.location_code, p_good, v_unit, 'PROD_RECEIPT', null, 'PRODUCTION', mo.id, mo.mo_no,
                         p_finish, p_user, 'Completed ' || mo.mo_no, mo.lot_no);
    perform app.gl(v_j, v_date, '1210', mo.component_cost, 'PROD_COMPLETE', mo.mo_no, 'Finished goods received', p_user);
  else
    perform app.gl(v_j, v_date, '5100', mo.component_cost, 'PROD_COMPLETE', mo.mo_no, 'Entire batch scrapped', p_user);
  end if;
  perform app.gl(v_j, v_date, '1250', -mo.component_cost, 'PROD_COMPLETE', mo.mo_no, 'Relieve work in process', p_user);
  perform app.gl_check(v_j);
  update production_orders set status = 'COMPLETED', actual_start = p_start, actual_finish = p_finish,
         qty_good = p_good, qty_scrap = p_scrap, scrap_reason = case when p_scrap > 0 then p_reason end,
         actual_unit_cost = v_unit, std_unit_cost = it.std_cost
   where id = mo.id;
  select cure_days into v_cure from settings where id = 1;
  insert into lots(lot_no, item_id, production_order_id, fragrance_lot, poured_on, sellable_on)
  values (mo.lot_no, mo.item_id, mo.id, mo.fragrance_lot, app.biz_date(p_start),
          app.biz_date(p_start) + case when it.category in ('candle_8oz','mini_tin') then v_cure else 0 end)
  on conflict (lot_no) do nothing;
end $$;

create or replace function public.complete_production_order(p_mo_id int, p_qty_good numeric, p_qty_scrap numeric default 0,
  p_scrap_reason text default null, p_actual_start timestamptz default null, p_actual_finish timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid;
begin
  v_uid := app.require_role(array['manager','production']);
  perform app._complete_mo(p_mo_id, p_qty_good, p_qty_scrap, p_scrap_reason, p_actual_start, p_actual_finish, v_uid);
  return (select jsonb_build_object('mo_no', mo_no, 'status', status, 'actual_unit_cost', actual_unit_cost,
                 'std_unit_cost', std_unit_cost, 'qty_good', qty_good) from production_orders where id = p_mo_id);
end $$;

create or replace function public.cancel_production_order(p_mo_id int)
returns jsonb language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role(array['manager','production']);
  update production_orders set status = 'CANCELLED' where id = p_mo_id and status = 'PLANNED';
  if not found then raise exception 'Only PLANNED (not yet issued) orders can be cancelled.'; end if;
  return jsonb_build_object('status','CANCELLED');
end $$;

-- Standard cost roll-up through the BOM (recursive for kits)
create or replace function app.rollup_std_cost() returns void language plpgsql as $$
declare i int;
begin
  for i in 1..4 loop   -- BOM is at most 3 levels deep
    update items p set std_cost = x.c
      from (select b.parent_id, round(sum(b.qty_per * c.std_cost), 4) c
              from bom_lines b join items c on c.id = b.component_id group by b.parent_id) x
     where p.id = x.parent_id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. INVENTORY ORDERING RULES (ROP / EOQ / safety stock) — all live
--    Usage = sales history in the window, exploded through the BOM so
--    components get dependent demand (gift set -> candles -> wax ...)
-- ---------------------------------------------------------------------
create or replace function app.reorder_core() returns table(
  item_id int, sku text, name text, item_type text, category text, uom text,
  supplier_id int, supplier_name text, ordering_policy text, unit_cost numeric, lead_time_days int,
  avg_daily numeric, sd_daily numeric, annual_demand numeric, z numeric, safety_stock numeric,
  rop_calc numeric, rop numeric, rop_is_override boolean, ordering_cost numeric, holding_pct numeric,
  holding_cost_unit numeric, eoq numeric, on_hand numeric, on_order numeric, inv_position numeric,
  status text, suggested_qty numeric, order_by date, review_days int, window_days int, min_order_qty numeric)
language sql stable as $$
with recursive
s as (select * from settings where id = 1),
w as (select app.today() - s.usage_window_days as d0, s.usage_window_days as n from s),
ex(top_id, item_id, mult) as (
  select id, id, 1::numeric from items
  union all
  select ex.top_id, b.component_id, ex.mult * b.qty_per from ex join bom_lines b on b.parent_id = ex.item_id),
sold as (
  select app.biz_date(sa.sale_at) d, sl.item_id, sum(sl.qty) q
    from sales sa join sale_lines sl on sl.sale_id = sa.id cross join w
   where sa.sale_at >= app.day_start(w.d0) and sa.sale_at < app.day_start(app.today())
   group by 1, 2),
dem as (select ex.item_id, sold.d, sum(sold.q * ex.mult) q from sold join ex on ex.top_id = sold.item_id group by 1, 2),
st as (
  select i.id, coalesce(sum(dem.q),0) / w.n avg_d,
         sqrt(greatest(coalesce(sum(dem.q^2),0) / w.n - (coalesce(sum(dem.q),0) / w.n)^2, 0)) sd
    from items i cross join w left join dem on dem.item_id = i.id
   group by i.id, w.n),
oh as (select b.item_id, sum(b.qty) q from inventory_balances b join locations l on l.code = b.location_code and l.sellable group by 1),
oo as (select x.item_id, sum(x.q) q from (
         select pl.item_id, pl.qty_ordered - pl.qty_received q from po_lines pl join purchase_orders p on p.id = pl.po_id
          where p.status in ('ORDER_SENT','PARTIALLY_RECEIVED') and pl.qty_ordered > pl.qty_received
         union all
         select mo.item_id, mo.qty_planned from production_orders mo where mo.status in ('PLANNED','IN_PROGRESS')) x group by 1),
base as (
  select i.id, i.sku, i.name, i.item_type, i.category, i.uom, i.preferred_supplier_id, sp.name sup_name, i.ordering_policy,
         coalesce(nullif(i.avg_cost,0), i.std_cost) ucost, i.lead_time_days lt, i.reorder_point_override ovr,
         st.avg_d, st.sd, coalesce(oh.q,0) on_hand, coalesce(oo.q,0) on_order,
         s.ordering_cost, s.holding_cost_pct, s.service_z, s.review_period_days, w.n,
         coalesce(si.min_order_qty, 1) moq
    from items i join st on st.id = i.id cross join s cross join w
    left join oh on oh.item_id = i.id left join oo on oo.item_id = i.id
    left join suppliers sp on sp.id = i.preferred_supplier_id
    left join supplier_items si on si.supplier_id = i.preferred_supplier_id and si.item_id = i.id
   where i.active),
c1 as (
  select base.*, round(service_z * sd * sqrt(lt::numeric), 2) ss, holding_cost_pct * ucost h, avg_d * 365 d_annual from base),
c2 as (
  select c1.*, round(avg_d * lt + ss, 2) rop_c,
         case when h > 0 and d_annual > 0 then ceil(sqrt(2 * d_annual * ordering_cost / h)) else 0 end q_eoq from c1),
c3 as (
  select c2.*, coalesce(ovr, rop_c) rop_e, on_hand + on_order pos from c2),
c4 as (
  select c3.*, case when (avg_d > 0 or ovr is not null) and pos <= rop_e then 'BELOW_ROP'
                    when avg_d > 0 and pos <= rop_e + avg_d * review_period_days then 'REVIEW'
                    else 'OK' end stat from c3)
select id, sku, name, item_type, category, uom, preferred_supplier_id, sup_name, ordering_policy, round(ucost,4), lt,
       round(avg_d,3), round(sd,3), round(d_annual,1), service_z, ss, rop_c, rop_e, ovr is not null,
       ordering_cost, holding_cost_pct, round(h,4), q_eoq, round(on_hand,2), round(on_order,2), round(pos,2), stat,
       case when stat = 'OK' then 0
            else greatest(q_eoq, ceil(rop_e + avg_d * review_period_days - pos), moq) end,
       case when avg_d > 0 then app.today() + greatest(0, floor((pos - rop_e) / avg_d))::int end,
       review_period_days, n, moq
  from c4
$$;

create or replace function public.fn_reorder_metrics()
returns table(
  item_id int, sku text, name text, item_type text, category text, uom text,
  supplier_id int, supplier_name text, ordering_policy text, unit_cost numeric, lead_time_days int,
  avg_daily numeric, sd_daily numeric, annual_demand numeric, z numeric, safety_stock numeric,
  rop_calc numeric, rop numeric, rop_is_override boolean, ordering_cost numeric, holding_pct numeric,
  holding_cost_unit numeric, eoq numeric, on_hand numeric, on_order numeric, inv_position numeric,
  status text, suggested_qty numeric, order_by date, review_days int, window_days int, min_order_qty numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','production','cashier']);
  return query select * from app.reorder_core();
end $$;

-- ---------------------------------------------------------------------
-- 10. FORECAST (Holiday Readiness Planner): last year's same weeks x trend
-- ---------------------------------------------------------------------
create or replace function app.forecast_weekly(p_weeks int) returns table(
  item_id int, week_no int, week_start date, ly_qty numeric, trend numeric, fcst numeric)
language sql stable as $$
with t as (
  select coalesce(sum(case when sa.sale_at >= app.day_start(app.today() - 56) then sl.qty end), 0) recent,
         coalesce(sum(case when sa.sale_at >= app.day_start(app.today() - 420)
                            and sa.sale_at <  app.day_start(app.today() - 364) then sl.qty end), 0) ly
    from sales sa join sale_lines sl on sl.sale_id = sa.id
   where sa.channel = 'POS' and sa.sale_at >= app.day_start(app.today() - 420)),
tr as (select case when ly > 0 then round(least(greatest(recent / ly, 0.8), 1.5), 3) else 1 end f from t),
wks as (select g w, app.today() + (g - 1) * 7 ws from generate_series(1, p_weeks) g),
ly as (
  select sl.item_id, wks.w, sum(sl.qty) q
    from wks join sales sa on sa.sale_at >= app.day_start(wks.ws - 364) and sa.sale_at < app.day_start(wks.ws - 357)
    join sale_lines sl on sl.sale_id = sa.id
   where sa.channel = 'POS' group by 1, 2)
select i.id, wks.w, wks.ws, coalesce(ly.q, 0), tr.f, round(coalesce(ly.q, 0) * tr.f, 1)
  from items i cross join wks cross join tr left join ly on ly.item_id = i.id and ly.w = wks.w
 where i.item_type in ('finished','kit','resale') and i.active
$$;

create or replace function public.fn_forecast(p_weeks int default 8, p_mult numeric default 1)
returns table(item_id int, sku text, name text, category text, week_no int, week_start date,
              ly_qty numeric, trend numeric, forecast numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','production']);
  return query select f.item_id, i.sku, i.name, i.category, f.week_no, f.week_start, f.ly_qty, f.trend,
                      round(f.fcst * p_mult, 1)
                 from app.forecast_weekly(p_weeks) f join items i on i.id = f.item_id;
end $$;

-- ---------------------------------------------------------------------
-- 11. MRP — weekly time-phased, low-level coded, recursive BOM explosion
-- ---------------------------------------------------------------------
create or replace function app._run_mrp(p_weeks int, p_lot text, p_mult numeric, p_forecast boolean, p_label text, p_user uuid)
returns int language plpgsql as $$
declare
  v_run int; v_today date := app.today(); v_end date; v_changed int; v_lvl int; v_max int;
  it record; bc record; w int; v_ws date; v_poh numeric; v_g numeric; v_s numeric; v_net numeric; v_por numeric;
  v_rel date; v_relw int; v_eoq numeric;
begin
  if p_weeks is null or p_weeks not between 1 and 26 then raise exception 'MRP horizon must be 1–26 weeks.'; end if;
  if p_lot not in ('LFL','EOQ') then raise exception 'Lot sizing must be LFL or EOQ.'; end if;
  p_mult := coalesce(p_mult, 1);
  v_end := v_today + p_weeks * 7;
  delete from mrp_runs where run_at < now() - interval '1 day';
  insert into mrp_runs(run_by, weeks, lot_rule, demand_mult, include_forecast, label)
  values (p_user, p_weeks, p_lot, p_mult, p_forecast, p_label) returning id into v_run;

  drop table if exists _llc, _gross, _sched, _ro;
  create temp table _llc(item_id int primary key, llc int) on commit drop;
  create temp table _gross(item_id int, week_no int, qty numeric) on commit drop;
  create temp table _sched(item_id int, week_no int, qty numeric) on commit drop;
  create temp table _ro on commit drop as select r.item_id, r.eoq from app.reorder_core() r;

  -- low-level codes: an item is planned only after every parent that uses it
  insert into _llc select id, 0 from items;
  loop
    update _llc c set llc = x.l from (
      select b.component_id, max(p.llc) + 1 l from bom_lines b join _llc p on p.item_id = b.parent_id group by b.component_id) x
     where c.item_id = x.component_id and c.llc < x.l;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  -- gross requirements: confirmed sales orders (remaining qty) by requested date
  insert into _gross
  select sl.item_id, greatest(1, (so.requested_date - v_today) / 7 + 1), sl.qty_ordered - sl.qty_fulfilled
    from so_lines sl join sales_orders so on so.id = sl.so_id
   where so.status in ('ORDER_PLACED','PARTIALLY_FULFILLED') and sl.qty_ordered > sl.qty_fulfilled and so.requested_date < v_end;
  -- optional walk-in forecast (Holiday Readiness Planner)
  if p_forecast then
    insert into _gross select f.item_id, f.week_no, ceil(f.fcst * p_mult) from app.forecast_weekly(p_weeks) f where f.fcst > 0;
  end if;
  -- components still to be issued for production orders already planned
  insert into _gross
  select b.component_id, greatest(1, (app.biz_date(mo.planned_start) - v_today) / 7 + 1), mo.qty_planned * b.qty_per
    from production_orders mo join bom_lines b on b.parent_id = mo.item_id
   where mo.status = 'PLANNED' and app.biz_date(mo.planned_start) < v_end;
  -- scheduled receipts: open POs and open production orders
  insert into _sched
  select pl.item_id, greatest(1, (p.expected_date - v_today) / 7 + 1), pl.qty_ordered - pl.qty_received
    from po_lines pl join purchase_orders p on p.id = pl.po_id
   where p.status in ('ORDER_SENT','PARTIALLY_RECEIVED') and pl.qty_ordered > pl.qty_received and p.expected_date < v_end;
  insert into _sched
  select mo.item_id, greatest(1, (app.biz_date(mo.planned_finish) - v_today) / 7 + 1), mo.qty_planned
    from production_orders mo where mo.status in ('PLANNED','IN_PROGRESS') and app.biz_date(mo.planned_finish) < v_end;

  select max(llc) into v_max from _llc;
  for v_lvl in 0..v_max loop
    for it in
      select i.id, i.uom, i.item_type, i.lead_time_days lt,
             coalesce((select sum(bb.qty) from inventory_balances bb join locations l on l.code = bb.location_code and l.sellable
                        where bb.item_id = i.id), 0) oh
        from items i join _llc c on c.item_id = i.id
       where c.llc = v_lvl and (exists (select 1 from _gross g where g.item_id = i.id)
                                or exists (select 1 from _sched s where s.item_id = i.id))
    loop
      v_poh := it.oh;
      select coalesce(r.eoq, 0) into v_eoq from _ro r where r.item_id = it.id;
      for w in 1..p_weeks loop
        v_ws := v_today + (w - 1) * 7;
        select coalesce(sum(qty), 0) into v_g from _gross where item_id = it.id and week_no = w;
        select coalesce(sum(qty), 0) into v_s from _sched where item_id = it.id and week_no = w;
        v_poh := v_poh + v_s - v_g;
        v_net := 0; v_por := 0; v_rel := null;
        if v_poh < 0 then
          v_net := -v_poh;
          v_por := case when p_lot = 'EOQ' then greatest(v_net, coalesce(v_eoq, 0)) else v_net end;
          v_por := ceil(v_por);
          v_poh := v_poh + v_por;
          v_rel := v_ws - it.lt;
        end if;
        insert into mrp_lines(run_id, item_id, llc, week_no, week_start, gross_req, sched_receipts, proj_on_hand,
                              net_req, planned_receipt, release_date, past_due)
        values (v_run, it.id, v_lvl, w, v_ws, v_g, v_s, v_poh, round(v_net, 2), v_por, v_rel, coalesce(v_rel < v_today, false));
        if v_por > 0 then
          v_relw := greatest(1, (v_rel - v_today) / 7 + 1);
          update mrp_lines set planned_release = planned_release + v_por
           where run_id = v_run and item_id = it.id and week_no = v_relw;
          -- explode the planned order into its components' gross requirements (recursion via low-level codes)
          for bc in select bl.component_id, bl.qty_per from bom_lines bl where bl.parent_id = it.id loop
            insert into _gross values (bc.component_id, v_relw, v_por * bc.qty_per);
          end loop;
        end if;
      end loop;
    end loop;
  end loop;

  -- pegging: which demand created each item's requirement (gross, through the BOM)
  insert into mrp_pegging(run_id, item_id, source_type, source_no, customer_name, top_item_id, path, need_date, week_no, qty)
  with recursive d(src_type, src, cust, top_id, item_id, q, nd, path) as (
    select 'SO'::text, so.so_no, c.name, sl.item_id, sl.item_id, (sl.qty_ordered - sl.qty_fulfilled)::numeric, so.requested_date, i.name::text
      from so_lines sl join sales_orders so on so.id = sl.so_id join customers c on c.id = so.customer_id join items i on i.id = sl.item_id
     where so.status in ('ORDER_PLACED','PARTIALLY_FULFILLED') and sl.qty_ordered > sl.qty_fulfilled and so.requested_date < v_end
    union all
    select 'FORECAST', 'Forecast wk ' || f.week_no, 'Walk-in forecast', f.item_id, f.item_id, ceil(f.fcst * p_mult), f.week_start, i.name::text
      from app.forecast_weekly(p_weeks) f join items i on i.id = f.item_id where p_forecast and f.fcst > 0
    union all
    select 'PROD_ORDER', mo.mo_no, 'Planned production', mo.item_id, b.component_id, mo.qty_planned * b.qty_per,
           app.biz_date(mo.planned_start), i.name || ' → ' || ci.name
      from production_orders mo join bom_lines b on b.parent_id = mo.item_id join items i on i.id = mo.item_id join items ci on ci.id = b.component_id
     where mo.status = 'PLANNED' and app.biz_date(mo.planned_start) < v_end
    union all
    select d.src_type, d.src, d.cust, d.top_id, b.component_id, d.q * b.qty_per, d.nd - pi.lead_time_days, d.path || ' → ' || ci.name
      from d join bom_lines b on b.parent_id = d.item_id join items pi on pi.id = d.item_id join items ci on ci.id = b.component_id
  )
  select v_run, item_id, src_type, src, cust, top_id, path, nd, greatest(1, (nd - v_today) / 7 + 1), q from d;

  return v_run;
end $$;

create or replace function public.run_mrp(p_weeks int default 4, p_lot_rule text default 'LFL',
  p_demand_mult numeric default 1, p_include_forecast boolean default false, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid; v_run int;
begin
  v_uid := app.require_role(array['manager','production']);
  v_run := app._run_mrp(p_weeks, p_lot_rule, p_demand_mult, p_include_forecast, p_label, v_uid);
  return jsonb_build_object('run_id', v_run,
    'items_planned', (select count(distinct item_id) from mrp_lines where run_id = v_run),
    'planned_orders', (select count(*) from mrp_lines where run_id = v_run and planned_receipt > 0),
    'past_due', (select count(*) from mrp_lines where run_id = v_run and past_due));
end $$;

-- ---------------------------------------------------------------------
-- 12. REPORTING VIEWS (security_invoker => RLS of the caller applies)
-- ---------------------------------------------------------------------
create or replace view v_on_hand with (security_invoker = true) as
select b.item_id, i.sku, i.name, i.item_type, i.category, i.uom, b.location_code, l.name location_name, l.sellable,
       b.qty, i.avg_cost, round(b.qty * i.avg_cost, 2) value
  from inventory_balances b join items i on i.id = b.item_id join locations l on l.code = b.location_code;

create or replace view v_inventory_valuation with (security_invoker = true) as
select i.id item_id, i.sku, i.name, i.item_type, i.category,
       case when i.item_type = 'raw' then 'Raw Materials' else 'Finished Goods' end inv_group,
       b.location_code, b.qty, i.avg_cost, round(b.qty * i.avg_cost, 2) value
  from inventory_balances b join items i on i.id = b.item_id
 where b.qty <> 0;

-- Proof that the balance table equals the ledger (should always return 0 rows with a difference)
create or replace view v_ledger_reconciliation with (security_invoker = true) as
select coalesce(b.item_id, t.item_id) item_id, coalesce(b.location_code, t.location_code) location_code,
       coalesce(b.qty, 0) balance_qty, coalesce(t.qty, 0) ledger_qty, coalesce(b.qty, 0) - coalesce(t.qty, 0) difference
  from inventory_balances b
  full join (select item_id, location_code, sum(qty) qty from inventory_transactions group by 1, 2) t
    on t.item_id = b.item_id and t.location_code = b.location_code;

create or replace view v_supplier_scorecard with (security_invoker = true) as
with po as (
  select p.*, (select min(r.received_date) from po_receipts r where r.po_id = p.id) first_rcv,
         (select sum(qty_ordered) from po_lines where po_id = p.id) q_ord,
         (select sum(qty_received) from po_lines where po_id = p.id) q_rcv
    from purchase_orders p where p.status in ('PARTIALLY_RECEIVED','RECEIVED','CLOSED')),
agg as (
  select s.id supplier_id, count(po.id) pos_received,
         avg(case when po.first_rcv <= po.expected_date then 1.0 else 0.0 end) on_time_rate,
         avg(po.first_rcv - po.order_date)::numeric avg_actual_lead,
         sum(po.q_rcv) / nullif(sum(po.q_ord), 0) fill_rate,
         avg(po.first_rcv - po.expected_date)::numeric avg_days_late
    from suppliers s left join po on po.supplier_id = s.id group by s.id),
ap as (
  select supplier_id, count(*) filter (where status = 'OPEN') open_invoices,
         coalesce(sum(amount - amount_paid) filter (where status = 'OPEN'), 0) amount_owed,
         count(*) filter (where status = 'OPEN' and due_date < app.today()) past_due_invoices,
         coalesce(sum(amount - amount_paid) filter (where status = 'OPEN' and due_date < app.today()), 0) past_due_amount,
         min(due_date) filter (where status = 'OPEN') next_due_date
    from ap_invoices group by supplier_id),
sc as (
  select s.id, s.name, s.contact_name, s.payment_terms, s.quoted_lead_days, agg.pos_received,
         round(agg.on_time_rate * 100, 1) on_time_pct, round(agg.avg_actual_lead, 1) avg_actual_lead,
         round(agg.avg_days_late, 1) avg_days_late, round(agg.fill_rate * 100, 1) fill_rate_pct,
         round(greatest(0, 1 - abs(agg.avg_actual_lead - s.quoted_lead_days) / nullif(s.quoted_lead_days, 0)) * 100, 1) lead_accuracy_pct,
         coalesce(ap.open_invoices, 0) open_invoices, coalesce(ap.amount_owed, 0) amount_owed,
         coalesce(ap.past_due_invoices, 0) past_due_invoices, coalesce(ap.past_due_amount, 0) past_due_amount, ap.next_due_date
    from suppliers s join agg on agg.supplier_id = s.id left join ap on ap.supplier_id = s.id)
select sc.*,
       round(0.4 * on_time_pct + 0.3 * fill_rate_pct + 0.3 * lead_accuracy_pct, 1) overall_score,
       case when pos_received = 0 then 'NO DATA'
            when 0.4 * on_time_pct + 0.3 * fill_rate_pct + 0.3 * lead_accuracy_pct >= st.score_keep_min then 'KEEP'
            when 0.4 * on_time_pct + 0.3 * fill_rate_pct + 0.3 * lead_accuracy_pct >= st.score_watch_min then 'WATCH'
            else 'REPLACE' end rating,
       st.score_keep_min, st.score_watch_min
  from sc cross join settings st;

-- Public catalogue for the customer portal: NO costs, availability by sellable location only.
-- (Definer view on purpose: customers cannot read items/balances directly.)
create or replace view v_catalog as
select i.id, i.sku, i.name, i.item_type, i.category, i.scent_family, i.scent_notes, i.description, i.price,
       i.color_hex, i.accent_hex,
       coalesce((select jsonb_object_agg(b.location_code, greatest(b.qty, 0)::int)
                   from inventory_balances b join locations l on l.code = b.location_code
                  where b.item_id = i.id and l.sellable and l.code <> 'WKS'), '{}'::jsonb) availability
  from items i
 where i.active and i.item_type in ('finished','kit','resale');

-- ---------------------------------------------------------------------
-- 13. REPORT FUNCTIONS
-- ---------------------------------------------------------------------
create or replace function public.fn_inventory_grid()
returns table(item_id int, sku text, name text, item_type text, category text, uom text, barcode text,
              wks numeric, whs numeric, str numeric, qah numeric, total numeric, avg_cost numeric, value numeric,
              rop numeric, eoq numeric, on_order numeric, status text, lead_time_days int)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  return query
  select i.id, i.sku, i.name, i.item_type, i.category, i.uom, i.barcode,
         coalesce(sum(b.qty) filter (where b.location_code = 'WKS'), 0),
         coalesce(sum(b.qty) filter (where b.location_code = 'WHS'), 0),
         coalesce(sum(b.qty) filter (where b.location_code = 'STR'), 0),
         coalesce(sum(b.qty) filter (where b.location_code = 'QAH'), 0),
         coalesce(sum(b.qty), 0), i.avg_cost, round(coalesce(sum(b.qty), 0) * i.avg_cost, 2),
         r.rop, r.eoq, r.on_order, r.status, i.lead_time_days
    from items i left join inventory_balances b on b.item_id = i.id
    left join app.reorder_core() r on r.item_id = i.id
   where i.active
   group by i.id, r.rop, r.eoq, r.on_order, r.status
   order by i.item_type, i.sku;
end $$;

create or replace function public.fn_dashboard_kpis()
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare v jsonb; t date := app.today(); ns numeric; cg numeric;
begin
  perform app.require_role(array['manager','cashier','production']);
  select coalesce(sum(credit - debit) filter (where account_code in ('4000','4100','4200')), 0),
         coalesce(sum(debit - credit) filter (where account_code = '5000'), 0)
    into ns, cg from gl_entries where entry_date > t - 30;
  select jsonb_build_object(
    'today_net_sales', (select coalesce(sum(subtotal - line_discounts - order_discount), 0) from sales where sale_at >= app.day_start(t))
                       - (select coalesce(sum(merchandise_amount), 0) from returns where return_at >= app.day_start(t)),
    'today_transactions', (select count(*) from sales where sale_at >= app.day_start(t) and channel <> 'EXCHANGE'),
    'today_units', (select coalesce(sum(sl.qty), 0) from sales s join sale_lines sl on sl.sale_id = s.id where s.sale_at >= app.day_start(t)),
    'mtd_net_sales', (select coalesce(sum(credit - debit), 0) from gl_entries where account_code in ('4000','4100','4200')
                       and entry_date >= date_trunc('month', t)::date),
    'gm_30d_pct', case when ns > 0 then round((ns - cg) / ns * 100, 1) end,
    'net_sales_30d', ns,
    'below_rop', (select count(*) from app.reorder_core() where status = 'BELOW_ROP'),
    'review_soon', (select count(*) from app.reorder_core() where status = 'REVIEW'),
    'open_sos', (select count(*) from sales_orders where status in ('ORDER_PLACED','PARTIALLY_FULFILLED')),
    'open_pickups', (select count(*) from sales_orders where status in ('ORDER_PLACED','PARTIALLY_FULFILLED') and channel = 'ONLINE_PICKUP'),
    'backordered_lines', (select count(*) from so_lines l join sales_orders o on o.id = l.so_id
                           where o.status = 'PARTIALLY_FULFILLED' and l.qty_fulfilled < l.qty_ordered),
    'open_pos', (select count(*) from purchase_orders where status in ('ORDER_SENT','PARTIALLY_RECEIVED')),
    'late_pos', (select count(*) from purchase_orders where status in ('ORDER_SENT','PARTIALLY_RECEIVED') and expected_date < t),
    'past_due_invoices', (select count(*) from ap_invoices where status = 'OPEN' and due_date < t),
    'past_due_amount', (select coalesce(sum(amount - amount_paid), 0) from ap_invoices where status = 'OPEN' and due_date < t),
    'ap_open', (select coalesce(sum(amount - amount_paid), 0) from ap_invoices where status = 'OPEN'),
    'ar_open', (select coalesce(sum(amount - amount_paid), 0) from ar_invoices where status = 'OPEN'),
    'ar_past_due', (select coalesce(sum(amount - amount_paid), 0) from ar_invoices where status = 'OPEN' and due_date < t),
    'qa_hold_units', (select coalesce(sum(qty), 0) from inventory_balances where location_code = 'QAH'),
    'mos_in_progress', (select count(*) from production_orders where status = 'IN_PROGRESS'),
    'mos_planned', (select count(*) from production_orders where status = 'PLANNED'),
    'inventory_value', (select coalesce(sum(b.qty * i.avg_cost), 0) from inventory_balances b join items i on i.id = b.item_id),
    'as_of', now()) into v;
  return v;
end $$;

-- Sales summary by bucket (day / week / month), location and channel
create or replace function public.fn_sales_summary(p_from date, p_to date, p_grain text default 'day')
returns table(bucket date, location_code text, channel text, net_sales numeric, cogs numeric, gross_profit numeric,
              transactions bigint, units numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  if p_grain not in ('day','week','month') then raise exception 'grain must be day, week or month'; end if;
  return query
  select date_trunc(p_grain, app.biz_date(s.sale_at))::date, s.location_code, s.channel,
         sum(s.subtotal - s.line_discounts - s.order_discount), sum(s.cogs_total),
         sum(s.subtotal - s.line_discounts - s.order_discount - s.cogs_total), count(*),
         sum((select sum(qty) from sale_lines where sale_id = s.id))
    from sales s
   where s.sale_at >= app.day_start(p_from) and s.sale_at < app.day_start(p_to + 1)
   group by 1, 2, 3 order by 1;
end $$;

create or replace function public.fn_item_sales(p_from date, p_to date)
returns table(item_id int, sku text, name text, item_type text, category text, scent_family text,
              units numeric, revenue numeric, cogs numeric, gross_profit numeric, returned_units numeric,
              last_sold date, on_hand numeric, days_since_sale int)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  return query
  with sl as (
    select l.item_id, sum(l.qty) u, sum(l.net_amount) rev, sum(round(l.qty * l.unit_cost, 2)) c
      from sale_lines l join sales s on s.id = l.sale_id
     where s.sale_at >= app.day_start(p_from) and s.sale_at < app.day_start(p_to + 1) group by 1),
  rl as (
    select r.item_id, sum(r.qty) u from return_lines r join returns h on h.id = r.return_id
     where h.return_at >= app.day_start(p_from) and h.return_at < app.day_start(p_to + 1) group by 1),
  ls as (select l.item_id, max(app.biz_date(s.sale_at)) d from sale_lines l join sales s on s.id = l.sale_id group by 1),
  oh as (select b.item_id, sum(b.qty) q from inventory_balances b where b.location_code <> 'QAH' group by 1)
  select i.id, i.sku, i.name, i.item_type, i.category, i.scent_family,
         coalesce(sl.u, 0), coalesce(sl.rev, 0), coalesce(sl.c, 0), coalesce(sl.rev, 0) - coalesce(sl.c, 0),
         coalesce(rl.u, 0), ls.d, coalesce(oh.q, 0), (app.today() - ls.d)
    from items i left join sl on sl.item_id = i.id left join rl on rl.item_id = i.id
    left join ls on ls.item_id = i.id left join oh on oh.item_id = i.id
   where i.item_type in ('finished','kit','resale') and i.active
   order by coalesce(sl.rev, 0) desc;
end $$;

create or replace function public.fn_returns_by_reason(p_from date, p_to date)
returns table(reason_code text, reason text, is_quality boolean, item_id int, sku text, name text, category text,
              disposition text, qty numeric, refund numeric, returns_count bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  return query
  select rl.reason_code, rc.description, rc.is_quality, i.id, i.sku, i.name, i.category, rl.disposition,
         sum(rl.qty), sum(rl.refund_amount), count(distinct rl.return_id)
    from return_lines rl join returns r on r.id = rl.return_id join reason_codes rc on rc.code = rl.reason_code
    join items i on i.id = rl.item_id
   where r.return_at >= app.day_start(p_from) and r.return_at < app.day_start(p_to + 1)
   group by 1, 2, 3, 4, 5, 6, 7, 8 order by sum(rl.qty) desc;
end $$;

create or replace function public.fn_pnl(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare v jsonb; g numeric; d numeric; r numeric; c numeric; wo numeric; adj numeric; ox numeric; oi numeric; ns numeric;
begin
  perform app.require_role(array['manager']);
  select coalesce(sum(credit - debit) filter (where account_code = '4000'), 0),
         coalesce(sum(debit - credit) filter (where account_code = '4100'), 0),
         coalesce(sum(debit - credit) filter (where account_code = '4200'), 0),
         coalesce(sum(debit - credit) filter (where account_code = '5000'), 0),
         coalesce(sum(debit - credit) filter (where account_code = '5100'), 0),
         coalesce(sum(debit - credit) filter (where account_code = '5200'), 0),
         coalesce(sum(debit - credit) filter (where account_code like '6%'), 0),
         coalesce(sum(credit - debit) filter (where account_code = '7000'), 0)
    into g, d, r, c, wo, adj, ox, oi
    from gl_entries where entry_date between p_from and p_to;
  ns := g - d - r;
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'gross_sales', g, 'discounts', d, 'returns', r, 'net_sales', ns,
    'cogs', c, 'gross_profit', ns - c, 'gross_margin_pct', case when ns <> 0 then round((ns - c) / ns * 100, 1) end,
    'writeoffs', wo, 'inventory_adjustments', adj,
    'operating_expenses', ox,
    'opex_detail', (select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'amount', x.amt) order by a.code), '[]')
                      from (select account_code, sum(debit - credit) amt from gl_entries
                             where entry_date between p_from and p_to and account_code like '6%' group by 1) x
                      join gl_accounts a on a.code = x.account_code),
    'other_income', oi,
    'operating_income', ns - c - wo - adj - ox,
    'net_income', ns - c - wo - adj - ox + oi,
    'by_month', (select coalesce(jsonb_agg(m order by m->>'month'), '[]') from (
                   select jsonb_build_object('month', to_char(date_trunc('month', entry_date), 'YYYY-MM'),
                     'net_sales', sum(credit - debit) filter (where account_code in ('4000','4100','4200')),
                     'cogs', coalesce(sum(debit - credit) filter (where account_code = '5000'), 0),
                     'expenses', coalesce(sum(debit - credit) filter (where account_code like '6%' or account_code in ('5100','5200')), 0)) m
                     from gl_entries where entry_date between p_from and p_to group by date_trunc('month', entry_date)) z),
    'trial_balance_check', (select coalesce(sum(debit) - sum(credit), 0) from gl_entries)
  ) into v;
  return v;
end $$;

create or replace function public.fn_inventory_summary()
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_role(array['manager']);
  return jsonb_build_object(
    'by_group', (select jsonb_agg(jsonb_build_object('group', inv_group, 'value', v, 'units', q)) from (
                   select inv_group, sum(value) v, sum(qty) q from v_inventory_valuation group by 1) x),
    'by_location', (select jsonb_agg(jsonb_build_object('location', location_code, 'raw', r, 'finished', f)) from (
                   select location_code, sum(value) filter (where inv_group = 'Raw Materials') r,
                          sum(value) filter (where inv_group = 'Finished Goods') f from v_inventory_valuation group by 1) y),
    'gl_raw', (select coalesce(sum(debit - credit), 0) from gl_entries where account_code = '1200'),
    'gl_finished', (select coalesce(sum(debit - credit), 0) from gl_entries where account_code = '1210'),
    'gl_wip', (select coalesce(sum(debit - credit), 0) from gl_entries where account_code = '1250'),
    'wip_orders', (select coalesce(sum(component_cost), 0) from production_orders where status = 'IN_PROGRESS'));
end $$;

-- Inventory turnover = COGS (or materials used) / average inventory value; days on hand = days / turns
create or replace function public.fn_turnover(p_from date, p_to date)
returns table(scope text, label text, cost_of_usage numeric, begin_value numeric, end_value numeric,
              avg_inventory numeric, turnover numeric, days_on_hand numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare v_days int := p_to - p_from + 1;
begin
  perform app.require_role(array['manager']);
  return query
  with pts as (   -- inventory value checkpoints: start, every month end inside the range, end
    select d from (select p_from - 1 d union select p_to
                   union select (date_trunc('month', g) + interval '1 month - 1 day')::date
                           from generate_series(p_from, p_to, interval '1 month') g) x
     where d between p_from - 1 and p_to),
  cat as (select id, case when item_type = 'raw' then 'Raw Materials' else 'Finished Goods' end grp,
                 category from items),
  val as (   -- value at each checkpoint = running sum of the ledger (qty x unit cost)
    select pts.d, cat.grp, cat.category, sum(t.qty * t.unit_cost) v
      from pts cross join cat
      join inventory_transactions t on t.item_id = cat.id and t.txn_at < app.day_start(pts.d + 1)
     group by 1, 2, 3),
  use_ as (  -- finished goods: cost of goods sold net of returns; raw materials: cost issued to production
    select cat.grp, cat.category,
           sum(case when cat.grp = 'Finished Goods' and t.txn_type = 'SALE' then -t.qty * t.unit_cost
                    when cat.grp = 'Finished Goods' and t.txn_type = 'RETURN' and t.note <> 'Returned - scrapped' then -t.qty * t.unit_cost
                    when cat.grp = 'Finished Goods' and t.txn_type = 'PROD_ISSUE' then -t.qty * t.unit_cost   -- candles used in kits
                    when cat.grp = 'Raw Materials' and t.txn_type = 'PROD_ISSUE' then -t.qty * t.unit_cost
                    else 0 end) u
      from inventory_transactions t join cat on cat.id = t.item_id
     where t.txn_at >= app.day_start(p_from) and t.txn_at < app.day_start(p_to + 1)
     group by 1, 2),
  rows_ as (
    select 'category' sc, c.category lbl,
           coalesce((select u from use_ where use_.category = c.category), 0) cu,
           coalesce((select sum(v) from val where val.category = c.category and val.d = p_from - 1), 0) bv,
           coalesce((select sum(v) from val where val.category = c.category and val.d = p_to), 0) ev,
           coalesce((select avg(s) from (select d, sum(v) s from val where val.category = c.category group by d) z), 0) av
      from (select distinct category from items) c
    union all
    select 'group', g.grp,
           coalesce((select sum(u) from use_ where use_.grp = g.grp), 0),
           coalesce((select sum(v) from val where val.grp = g.grp and val.d = p_from - 1), 0),
           coalesce((select sum(v) from val where val.grp = g.grp and val.d = p_to), 0),
           coalesce((select avg(s) from (select d, sum(v) s from val where val.grp = g.grp group by d) z), 0)
      from (values ('Raw Materials'), ('Finished Goods')) g(grp)
    union all
    select 'overall', 'All inventory (COGS basis)',
           (select coalesce(sum(debit - credit), 0) from gl_entries where account_code = '5000' and entry_date between p_from and p_to),
           coalesce((select sum(v) from val where val.d = p_from - 1), 0),
           coalesce((select sum(v) from val where val.d = p_to), 0),
           coalesce((select avg(s) from (select d, sum(v) s from val group by d) z), 0))
  select sc, lbl, round(cu, 2), round(bv, 2), round(ev, 2), round(av, 2),
         case when av > 0 then round(cu / av * 365.0 / v_days, 2) end,            -- annualised turns
         case when cu > 0 then round(av / (cu / v_days), 1) end                    -- days of inventory on hand
    from rows_ where av > 0 or cu > 0
   order by case sc when 'overall' then 0 when 'group' then 1 else 2 end, lbl;
end $$;

create or replace function public.fn_production_metrics(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare v jsonb;
begin
  perform app.require_role(array['manager','production']);
  with mo as (
    select m.*, i.sku, i.name, i.category,
           extract(epoch from (m.actual_finish - m.actual_start)) / 3600.0 hrs
      from production_orders m join items i on i.id = m.item_id
     where m.status = 'COMPLETED' and m.actual_finish >= app.day_start(p_from) and m.actual_finish < app.day_start(p_to + 1))
  select jsonb_build_object(
    'orders', (select count(*) from mo),
    'units_started', (select coalesce(sum(qty_started), 0) from mo),
    'units_good', (select coalesce(sum(qty_good), 0) from mo),
    'units_scrap', (select coalesce(sum(qty_scrap), 0) from mo),
    'first_pass_yield_pct', (select round(sum(qty_good) / nullif(sum(qty_started), 0) * 100, 1) from mo),
    'scrap_rate_pct', (select round(sum(qty_scrap) / nullif(sum(qty_started), 0) * 100, 1) from mo),
    'throughput_units_per_hr', (select round(sum(qty_good) / nullif(sum(hrs), 0), 1) from mo),
    'avg_cycle_time_hrs', (select round(avg(hrs)::numeric, 1) from mo),
    'on_time_pct', (select round(avg(case when actual_finish <= planned_finish then 100.0 else 0 end), 1) from mo),
    'cost_variance_total', (select round(sum((actual_unit_cost - std_unit_cost) * qty_good), 2) from mo),
    'avg_cost_variance_pct', (select round(avg((actual_unit_cost - std_unit_cost) / nullif(std_unit_cost, 0)) * 100, 1) from mo),
    'scrap_by_reason', (select coalesce(jsonb_agg(x order by x->>'qty' desc), '[]') from (
        select jsonb_build_object('reason', mo.scrap_reason, 'description', rc.description, 'qty', sum(mo.qty_scrap),
               'pct_of_started', round(sum(mo.qty_scrap) / nullif((select sum(qty_started) from mo), 0) * 100, 2)) x
          from mo join reason_codes rc on rc.code = mo.scrap_reason where mo.qty_scrap > 0 group by mo.scrap_reason, rc.description) s),
    'by_item', (select coalesce(jsonb_agg(x order by x->>'sku'), '[]') from (
        select jsonb_build_object('sku', sku, 'name', name, 'orders', count(*), 'started', sum(qty_started),
               'good', sum(qty_good), 'scrap', sum(qty_scrap),
               'fpy_pct', round(sum(qty_good) / nullif(sum(qty_started), 0) * 100, 1),
               'avg_actual_cost', round(sum(actual_unit_cost * qty_good) / nullif(sum(qty_good), 0), 4),
               'std_cost', round(avg(std_unit_cost), 4),
               'variance_pct', round((sum(actual_unit_cost * qty_good) / nullif(sum(qty_good), 0) - avg(std_unit_cost)) / nullif(avg(std_unit_cost), 0) * 100, 1),
               'units_per_hr', round(sum(qty_good) / nullif(sum(hrs), 0), 1)) x
          from mo group by sku, name) b),
    'by_week', (select coalesce(jsonb_agg(x order by x->>'week'), '[]') from (
        select jsonb_build_object('week', date_trunc('week', app.biz_date(actual_finish))::date, 'good', sum(qty_good),
               'scrap', sum(qty_scrap), 'fpy_pct', round(sum(qty_good) / nullif(sum(qty_started), 0) * 100, 1)) x
          from mo group by date_trunc('week', app.biz_date(actual_finish))) w)
  ) into v;
  return v;
end $$;

-- Backorders with estimated availability (open PO / production order date, else today + lead time)
create or replace function public.fn_backorders()
returns table(so_id int, so_no text, customer_name text, requested_date date, location_code text, item_id int, sku text,
              name text, qty_ordered numeric, qty_fulfilled numeric, qty_open numeric, on_hand_at_location numeric,
              qty_short numeric, est_available date, est_source text, is_backordered boolean)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  return query
  with ol as (
    select so.id, so.so_no, c.name cname, so.requested_date, so.location_code, l.item_id, i.sku, i.name iname,
           l.qty_ordered, l.qty_fulfilled, l.qty_ordered - l.qty_fulfilled q_open, app.on_hand(l.item_id, so.location_code) oh,
           l.backordered, i.lead_time_days
      from so_lines l join sales_orders so on so.id = l.so_id join customers c on c.id = so.customer_id join items i on i.id = l.item_id
     where so.status in ('ORDER_PLACED','PARTIALLY_FULFILLED') and l.qty_ordered > l.qty_fulfilled),
  sup as (
    select ol.*,
      (select min(p.expected_date) from po_lines pl join purchase_orders p on p.id = pl.po_id
        where pl.item_id = ol.item_id and p.status in ('ORDER_SENT','PARTIALLY_RECEIVED') and pl.qty_received < pl.qty_ordered) po_d,
      (select min(app.biz_date(m.planned_finish)) from production_orders m
        where m.item_id = ol.item_id and m.status in ('PLANNED','IN_PROGRESS')) mo_d
      from ol)
  select id, so_no, cname, requested_date, location_code, item_id, sku, iname, qty_ordered, qty_fulfilled, q_open, oh,
         greatest(q_open - oh, 0),
         case when q_open <= oh then app.today()
              else coalesce(least(po_d, mo_d), app.today() + lead_time_days) end,
         case when q_open <= oh then 'In stock at ' || location_code
              when po_d is not null and (mo_d is null or po_d <= mo_d) then 'Open purchase order'
              when mo_d is not null then 'Open production order'
              else 'Today + lead time (' || lead_time_days || ' d)' end,
         backordered
    from sup
   where backordered or q_open > oh
   order by requested_date;
end $$;

-- Item lookup by barcode / SKU (used by every scan field)
create or replace function public.fn_lookup_item(p_code text)
returns table(id int, sku text, name text, item_type text, uom text, barcode text, price numeric, avg_cost numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_role(array['manager','cashier','production']);
  return query select i.id, i.sku, i.name, i.item_type, i.uom, i.barcode, i.price, i.avg_cost from items i
   where upper(i.barcode) = upper(trim(p_code)) or upper(i.sku) = upper(trim(p_code)) limit 1;
end $$;
