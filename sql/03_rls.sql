-- =====================================================================
-- Emblet Co. Mini-ERP  |  03_rls.sql
-- Row Level Security, grants, signup trigger, and Realtime publication.
-- Rule of thumb: staff can READ internal tables; NOBODY writes business
-- tables directly — all writes go through the SECURITY DEFINER RPCs in
-- 02_functions.sql (which check the caller's role). Customers see only
-- the cost-free catalogue view and their own customer row / orders.
-- =====================================================================

-- ---------- signup: every new auth user gets a profile (role = customer) and a customer record ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), 'customer')
  on conflict (id) do nothing;
  insert into public.customers(user_id, name, email, customer_type)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), new.email, 'retail')
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- grants ----------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;   -- RLS below decides
revoke all on doc_counters from authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user() from authenticated;

revoke all on schema app from public;
grant usage on schema app to authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.is_staff(), app.is_manager(), app.my_role(), app.my_customer_id(),
                          app.today(), app.biz_date(timestamptz), app.day_start(date), app.tz() to authenticated;

-- ---------- enable RLS everywhere ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
-- (table owner / service role / SECURITY DEFINER functions owned by postgres bypass RLS)
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I no force row level security', t);
  end loop;
end $$;

-- ---------- policies ----------
do $$
declare p record;
begin   -- make this file re-runnable: drop existing policies first
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
-- reference data readable by any signed-in user
create policy settings_read  on settings  for select to authenticated using (true);
create policy settings_write on settings  for update to authenticated using ((select app.is_manager())) with check ((select app.is_manager()));
create policy locations_read on locations for select to authenticated using (true);
create policy reasons_read   on reason_codes for select to authenticated using (true);

-- profiles: see yourself; staff see everyone; only admins change roles
create policy profiles_read  on profiles for select to authenticated using (id = auth.uid() or (select app.is_staff()));
create policy profiles_admin on profiles for update to authenticated
  using ((select app.my_role()) = 'admin') with check ((select app.my_role()) = 'admin');

-- master data: staff read, managers maintain
create policy items_read     on items          for select to authenticated using ((select app.is_staff()));
create policy items_write    on items          for all    to authenticated using ((select app.is_manager())) with check ((select app.is_manager()));
create policy bom_read       on bom_lines      for select to authenticated using ((select app.is_staff()));
create policy bom_write      on bom_lines      for all    to authenticated using ((select app.is_manager())) with check ((select app.is_manager()));
create policy sup_read       on suppliers      for select to authenticated using ((select app.is_staff()));
create policy sup_write      on suppliers      for all    to authenticated using ((select app.is_manager())) with check ((select app.is_manager()));
create policy supitem_read   on supplier_items for select to authenticated using ((select app.is_staff()));
create policy supitem_write  on supplier_items for all    to authenticated using ((select app.is_manager())) with check ((select app.is_manager()));

-- customers: staff read/maintain; a customer sees only their own record
create policy cust_read      on customers for select to authenticated using ((select app.is_staff()) or user_id = auth.uid());
create policy cust_insert    on customers for insert to authenticated with check ((select app.my_role()) in ('admin','manager','cashier'));
create policy cust_update    on customers for update to authenticated using ((select app.my_role()) in ('admin','manager','cashier'))
                                                                 with check ((select app.my_role()) in ('admin','manager','cashier'));

-- staff-readable transactional tables (writes only through RPCs)
do $$
declare t text;
begin
  foreach t in array array['inventory_transactions','inventory_balances','lots','payments','returns','return_lines','exchanges',
                           'purchase_orders','po_lines','po_receipts','receipt_lines','ap_invoices','ap_payments',
                           'production_orders','mrp_runs','mrp_lines','mrp_pegging'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select app.is_staff()))', t || '_staff_read', t);
  end loop;
end $$;

-- finance: managers only
create policy gl_acct_read on gl_accounts for select to authenticated using ((select app.is_staff()));
create policy gl_read      on gl_entries  for select to authenticated using ((select app.is_manager()));
create policy ar_read      on ar_invoices for select to authenticated using ((select app.is_staff()));
create policy arp_read     on ar_payments for select to authenticated using ((select app.is_manager()));

-- sales & orders: staff see all; customers see their own
create policy sales_read   on sales      for select to authenticated
  using ((select app.is_staff()) or customer_id = (select app.my_customer_id()));
create policy saleln_read  on sale_lines for select to authenticated
  using ((select app.is_staff()) or exists (select 1 from sales s where s.id = sale_id and s.customer_id = (select app.my_customer_id())));
create policy so_read      on sales_orders for select to authenticated
  using ((select app.is_staff()) or customer_id = (select app.my_customer_id()));
create policy soln_read    on so_lines for select to authenticated
  using ((select app.is_staff()) or exists (select 1 from sales_orders o where o.id = so_id and o.customer_id = (select app.my_customer_id())));

-- the catalogue view (no cost columns) is the ONLY item data a customer can read
grant select on v_catalog to authenticated;

-- customers must not read cost-bearing columns on their own sale lines either
revoke select on sale_lines from authenticated;
grant select (id, sale_id, line_no, item_id, qty, unit_price, line_discount, order_disc_alloc, net_amount, tax_amount, qty_returned, lot_no)
  on sale_lines to authenticated;
-- staff read full sale lines (incl. unit_cost) through this definer view, filtered to staff callers
create or replace view v_sale_lines_staff as
  select sl.* from sale_lines sl where app.is_staff();
grant select on v_sale_lines_staff to authenticated;
revoke select on sales from authenticated;
grant select (id, receipt_no, sale_at, location_code, channel, customer_id, sales_order_id, cashier_id, subtotal,
              line_discounts, order_discount, tax_rate, tax, total, payment_method, note) on sales to authenticated;
create or replace view v_sales_staff as
  select s.* from sales s where app.is_staff();
grant select on v_sales_staff to authenticated;

-- ---------- Realtime ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['inventory_balances','sales','sales_orders','so_lines','purchase_orders','production_orders',
                           'returns','ap_invoices','settings','items'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
