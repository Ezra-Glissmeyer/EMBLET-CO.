import { sb, q, rpc, getItems, getLocations } from '../lib/db.js';
import { h, money, qty, fmtDate, fmtDT, badge, table, tabs, modal, field, select, toast, run, isoDate, addDays, locName, loading, confirmBox } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';
import { showReceipt } from '../lib/docs.js';

export default async function orders(root, ctx) {
  const [items, locs, customers] = await Promise.all([getItems(), getLocations(), q(sb.from('customers').select('id, name, customer_type').order('name'))]);
  let view = 'open';
  const body = h('div');
  const newBtn = h('button', { class: 'primary', onclick: () => newOrder() }, '+ New sales order');
  root.append(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('div', {}, h('h1', {}, 'Sales orders'),
    h('div', { class: 'muted' }, 'Wholesale, phone and website pickup orders. Order Placed → Fulfilled → Closed (or Cancelled). Open orders feed MRP.')), h('div', { class: 'sp' }), newBtn),
    tabs([['open', 'Open orders & pickup queue'], ['back', 'Backorders'], ['all', 'All orders']], view, k => { view = k; load(); }), body);

  async function load() {
    body.replaceChildren(loading());
    if (view === 'back') {
      const rows = await rpc('fn_backorders');
      body.replaceChildren(h('div', { class: 'callout', style: { marginBottom: '10px' } },
        'Estimated available date = the earliest open purchase order or production order for the item; if none exists, today + the item\'s lead time.'),
        table([
          { key: 'so_no', label: 'Order', fmt: r => h('a', { href: 'javascript:void 0', onclick: () => openOrder(r.so_id) }, r.so_no) },
          { key: 'customer_name', label: 'Customer' }, { key: 'requested_date', label: 'Requested', fmt: r => fmtDate(r.requested_date) },
          { key: 'sku', label: 'Item', fmt: r => `${r.sku} · ${r.name}` },
          { key: 'qty_open', label: 'Open qty', num: true, fmt: r => qty(r.qty_open) },
          { key: 'on_hand_at_location', label: `On hand at loc.`, num: true, fmt: r => qty(r.on_hand_at_location) + ' @' + r.location_code },
          { key: 'qty_short', label: 'Short', num: true, fmt: r => h('b', { style: { color: r.qty_short > 0 ? 'var(--red)' : '' } }, qty(r.qty_short)) },
          { key: 'is_backordered', label: '', fmt: r => r.is_backordered ? badge('PARTIALLY_FULFILLED', 'Backordered') : badge('OPEN', 'At risk') },
          { key: 'est_available', label: 'Est. available', fmt: r => fmtDate(r.est_available) },
          { key: 'est_source', label: 'Based on', fmt: r => h('span', { class: 'muted' }, r.est_source) },
        ], rows, { empty: 'No backorders — every open line can ship from stock. 🎉' }));
      return;
    }
    let qb = sb.from('sales_orders').select('id, so_no, channel, status, order_date, requested_date, location_code, created_at, customers(name, customer_type), so_lines(qty_ordered, qty_fulfilled, unit_price, discount_pct)');
    qb = view === 'open' ? qb.in('status', ['ORDER_PLACED', 'PARTIALLY_FULFILLED']).order('requested_date') : qb.order('id', { ascending: false }).limit(250);
    const rows = await q(qb);
    const value = r => r.so_lines.reduce((s, l) => s + l.qty_ordered * l.unit_price * (1 - l.discount_pct / 100), 0);
    const cols = [
      { key: 'so_no', label: 'Order', fmt: r => h('b', {}, r.so_no) },
      { key: 'channel', label: 'Channel', fmt: r => badge(r.channel === 'ONLINE_PICKUP' ? 'tan' : 'x', r.channel === 'ONLINE_PICKUP' ? 'Website pickup' : r.channel === 'WHOLESALE' ? 'Wholesale' : 'Phone') },
      { key: 'customer', label: 'Customer', fmt: r => r.customers?.name },
      { key: 'location_code', label: 'Location', fmt: r => locName(r.location_code) },
      { key: 'order_date', label: 'Ordered', fmt: r => fmtDate(r.order_date) },
      { key: 'requested_date', label: 'Requested / pickup', fmt: r => h('span', { style: { color: r.requested_date < isoDate() && view === 'open' ? 'var(--red)' : '' } }, fmtDate(r.requested_date)) },
      { key: 'units', label: 'Units', num: true, fmt: r => qty(r.so_lines.reduce((s, l) => s + Number(l.qty_ordered), 0)) },
      { key: 'value', label: 'Value', num: true, fmt: r => money(value(r)) },
      { key: 'status', label: 'Status', fmt: r => badge(r.status) },
    ];
    if (view === 'open') {
      const pick = rows.filter(r => r.channel === 'ONLINE_PICKUP'), other = rows.filter(r => r.channel !== 'ONLINE_PICKUP');
      body.replaceChildren(
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, '🛍️ Storefront pickup queue'), h('span', { class: 'muted' }, 'Website orders appear here instantly (Realtime).')),
          table(cols, pick, { onRow: r => openOrder(r.id), empty: 'No pickup orders waiting.' })),
        h('div', { class: 'card' }, h('h2', {}, 'Wholesale & phone orders'), table(cols, other, { onRow: r => openOrder(r.id), empty: 'No open wholesale orders.' })));
    } else body.replaceChildren(table(cols, rows, { onRow: r => openOrder(r.id), scroll: true }));
  }

  async function openOrder(id) {
    const so = await q(sb.from('sales_orders').select('*, customers(name, customer_type, email, phone), so_lines(*, items(sku, name))').eq('id', id).single());
    const bal = await q(sb.from('inventory_balances').select('item_id, location_code, qty').in('item_id', so.so_lines.map(l => l.item_id)));
    const at = (iid, loc) => Number(bal.find(b => b.item_id === iid && b.location_code === loc)?.qty || 0);
    const invoices = await q(sb.from('sales').select('id, receipt_no, sale_at, total, payment_method').eq('sales_order_id', id).order('id'));
    const open = ['ORDER_PLACED', 'PARTIALLY_FULFILLED'].includes(so.status);
    const shipInputs = {};
    const lines = so.so_lines.sort((a, b) => a.line_no - b.line_no);
    const pay = select([['CARD', 'Card'], ['CASH', 'Cash']], 'CARD');
    const bodyEl = h('div', {},
      h('div', { class: 'row' }, badge(so.status), h('span', {}, `${so.customers.name} · ${so.channel.replace('_', ' ')} · ${locName(so.location_code)}`),
        h('span', { class: 'sp' }), h('span', { class: 'muted' }, `Ordered ${fmtDate(so.order_date)} · requested ${fmtDate(so.requested_date)}`)),
      so.notes ? h('p', { class: 'muted' }, so.notes) : null,
      table([
        { key: 'sku', label: 'Item', fmt: l => `${l.items.sku} · ${l.items.name}` },
        { key: 'qty_ordered', label: 'Ordered', num: true, fmt: l => qty(l.qty_ordered) },
        { key: 'qty_fulfilled', label: 'Shipped', num: true, fmt: l => qty(l.qty_fulfilled) },
        { key: 'open', label: 'Open', num: true, fmt: l => h('b', {}, qty(l.qty_ordered - l.qty_fulfilled)) },
        { key: 'oh', label: `On hand @${so.location_code}`, num: true, fmt: l => {
          const o = at(l.item_id, so.location_code), need = l.qty_ordered - l.qty_fulfilled;
          return h('span', { style: { color: need > o ? 'var(--red)' : '' } }, qty(o));
        } },
        { key: 'price', label: 'Price', num: true, fmt: l => money(l.unit_price) + (Number(l.discount_pct) ? ` −${l.discount_pct}%` : '') },
        { key: 'ship', label: 'Ship now', fmt: l => {
          const left = l.qty_ordered - l.qty_fulfilled;
          if (!open || left <= 0) return l.backordered ? badge('PARTIALLY_FULFILLED', 'Backordered') : '';
          const inp = h('input', { type: 'number', class: 'inline-in', min: 0, max: left, value: Math.min(left, at(l.item_id, so.location_code)) });
          shipInputs[l.id] = inp; return inp;
        } },
      ], lines),
      invoices.length ? h('div', { style: { marginTop: '12px' } }, h('h3', {}, 'Shipments / invoices'),
        ...invoices.map(i => h('div', { class: 'row' }, h('a', { href: 'javascript:void 0', onclick: () => showReceipt(i.id) }, i.receipt_no), h('span', {}, fmtDT(i.sale_at)), h('span', {}, money(i.total)), h('span', { class: 'muted' }, i.payment_method)))) : null,
      open && so.customers.customer_type !== 'wholesale' ? field('Customer pays by', pay) : null,
      open && so.customers.customer_type === 'wholesale' ? h('p', { class: 'hint' }, 'Wholesale shipments are invoiced to Accounts Receivable (Net ' + 30 + '), tax-exempt for resale.') : null);
    const actions = [{ label: 'Close' }];
    if (so.status === 'ORDER_PLACED') actions.unshift({ label: 'Cancel order', class: 'danger', onClick: async () => {
      if (!await confirmBox('Cancel order?', `Cancel ${so.so_no}? This cannot be undone.`, 'Cancel order', true)) return false;
      await rpc('cancel_sales_order', { p_so_id: so.id, p_reason: 'Cancelled by staff' }); toast(`${so.so_no} cancelled`); load(); return true; } });
    if (['FULFILLED', 'PARTIALLY_FULFILLED'].includes(so.status)) actions.push({ label: so.status === 'PARTIALLY_FULFILLED' ? 'Close (cancel backorder)' : 'Close order', onClick: async () => {
      await rpc('close_sales_order', { p_so_id: so.id }); toast(`${so.so_no} closed`); load(); return true; } });
    if (open) actions.push({ label: '📦 Fulfill / ship', class: 'primary', onClick: async () => {
      const ls = Object.entries(shipInputs).map(([id, inp]) => ({ so_line_id: Number(id), qty: Number(inp.value) || 0 })).filter(x => x.qty > 0);
      if (!ls.length) throw new Error('Enter a quantity to ship on at least one line (or transfer stock to ' + so.location_code + ' first).');
      const res = await rpc('fulfill_sales_order', { p_so_id: so.id, p_lines: ls, p_payment_method: pay.value });
      toast(`Shipped on ${res.invoice_no} · ${money(res.total)} · order is now ${res.status.replace('_', ' ').toLowerCase()}`);
      load(); showReceipt(res.sale_id); return true; } });
    modal({ title: 'Sales order ' + so.so_no, wide: true, body: bodyEl, actions });
  }

  function newOrder() {
    const cust = select(customers.map(c => [c.id, `${c.name}${c.customer_type === 'wholesale' ? ' (wholesale)' : ''}`]), '');
    const loc = select(locs.filter(l => l.sellable).map(l => [l.code, l.name]), 'STR');
    cust.addEventListener('change', () => { if (customers.find(c => c.id == cust.value)?.customer_type === 'wholesale') loc.value = 'WHS'; });
    const date = h('input', { type: 'date', value: addDays(isoDate(), 3), min: isoDate() });
    const notes = h('input', { placeholder: 'Optional notes' });
    const linesBox = h('div');
    const lines = [{ item: '', qty: 1 }];
    const sellable = items.filter(i => i.active && i.item_type !== 'raw');
    const draw = () => linesBox.replaceChildren(...lines.map((l, i) => h('div', { class: 'row', style: { marginBottom: '6px' } },
      select([['', 'Choose item…'], ...sellable.map(it => [it.id, `${it.sku} · ${it.name} (${money(it.price)})`])], l.item, { style: { flex: 1 }, onchange: e => { l.item = e.target.value; } }),
      h('input', { type: 'number', min: 1, value: l.qty, class: 'inline-in', onchange: e => { l.qty = Number(e.target.value); } }),
      h('button', { class: 'sm ghost', onclick: () => { lines.splice(i, 1); draw(); } }, '✕'))),
      h('button', { class: 'sm', onclick: () => { lines.push({ item: '', qty: 1 }); draw(); } }, '+ Add line'));
    draw();
    modal({ title: 'New sales order', wide: true, body: h('div', {},
      h('div', { class: 'fields' }, field('Customer', cust), field('Fulfillment / pickup location', loc), field('Requested date', date)),
      field('Notes', notes), h('label', {}, 'Lines'), linesBox,
      h('p', { class: 'hint' }, 'Wholesale accounts are priced automatically at the wholesale rate (Settings).')),
      actions: [{ label: 'Cancel' }, { label: 'Create order', class: 'primary', onClick: async () => {
        const ls = lines.filter(l => l.item && l.qty > 0).map(l => ({ item_id: Number(l.item), qty: l.qty }));
        if (!cust.value) throw new Error('Choose a customer.');
        if (!ls.length) throw new Error('Add at least one item.');
        const res = await rpc('create_sales_order', { p_customer_id: Number(cust.value), p_location: loc.value, p_requested_date: date.value, p_lines: ls, p_channel: 'PHONE', p_notes: notes.value || null });
        toast(`Created ${res.so_no}`); load(); return true; } }] });
  }

  await load();
  if (ctx.params.get('so')) openOrder(Number(ctx.params.get('so')));
  return onChange(['sales_orders', 'so_lines', 'inventory_balances'], () => load().catch(() => {}), 500);
}
