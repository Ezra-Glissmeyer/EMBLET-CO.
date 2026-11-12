import { rpc, sb, q } from '../lib/db.js';
import { h, money, num, pct, qty, kpi, table, badge, chart, fmtDate, isoDate, addDays, loading, palette } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function dashboard(root, ctx) {
  const tiles = h('div', { class: 'kpis' }, loading());
  const salesCanvas = h('canvas', { height: 120 });
  const lowBox = h('div', {}, loading());
  const queueBox = h('div', {}, loading());
  const asOf = h('span', { class: 'muted' });
  root.append(
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('div', {}, h('h1', {}, greeting(ctx.profile)), h('div', { class: 'muted' }, 'Every number here is calculated live from the ledger and updates when anyone posts a transaction. ', asOf))),
    tiles,
    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Net sales — last 30 days'), h('div', { class: 'spacer' }), h('span', { class: 'muted' }, 'by channel')), salesCanvas),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Open orders queue'), h('div', { class: 'spacer' }), h('a', { href: '#/orders' }, 'All orders →')), queueBox)),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Low stock & reorder alerts'), h('div', { class: 'spacer' }), h('a', { href: '#/reorder' }, 'Reorder review →')), lowBox));

  async function load() {
    const [k, series, ro, sos] = await Promise.all([
      rpc('fn_dashboard_kpis'),
      rpc('fn_sales_summary', { p_from: addDays(isoDate(), -29), p_to: isoDate(), p_grain: 'day' }),
      rpc('fn_reorder_metrics'),
      q(sb.from('sales_orders').select('id, so_no, channel, status, requested_date, location_code, customers(name)')
        .in('status', ['ORDER_PLACED', 'PARTIALLY_FULFILLED']).order('requested_date').limit(12)),
    ]);
    asOf.textContent = 'As of ' + new Date(k.as_of).toLocaleTimeString();
    tiles.replaceChildren(
      kpi("Today's net sales", money(k.today_net_sales), `${k.today_transactions} transactions · ${num(k.today_units)} units`, 'good', '#/reports'),
      kpi('Gross margin (30 d)', pct(k.gm_30d_pct), `on ${money(k.net_sales_30d, true)} net sales`, '', ctx.role === 'cashier' ? null : '#/financials'),
      kpi('Month-to-date', money(k.mtd_net_sales, true), 'net sales (GL)'),
      kpi('Items below ROP', num(k.below_rop), `${k.review_soon} more due within review period`, k.below_rop ? 'bad' : 'good', '#/reorder'),
      kpi('Open sales orders', num(k.open_sos), `${k.open_pickups} pickups · ${k.backordered_lines} backordered lines`, k.backordered_lines ? 'warn' : '', '#/orders'),
      kpi('Open purchase orders', num(k.open_pos), k.late_pos ? `${k.late_pos} past expected date` : 'none late', k.late_pos ? 'warn' : '', '#/purchasing'),
      kpi('Past-due invoices', num(k.past_due_invoices), money(k.past_due_amount) + ' owed to suppliers', k.past_due_invoices ? 'bad' : 'good', '#/suppliers'),
      kpi('Production', `${k.mos_in_progress} running`, `${k.mos_planned} planned · QA hold ${qty(k.qa_hold_units)} units`, '', '#/production'),
      kpi('Inventory value', money(k.inventory_value, true), `A/R open ${money(k.ar_open, true)} · A/P open ${money(k.ap_open, true)}`));

    // chart: stacked by channel
    const days = [...Array(30)].map((_, i) => addDays(isoDate(), i - 29));
    const chans = [...new Set(series.map(r => r.channel))];
    chart(salesCanvas, {
      type: 'bar',
      data: { labels: days.map(d => fmtDate(d).replace(/, \d{4}/, '')),
        datasets: chans.map((c, i) => ({ label: c.replace('_', ' '), backgroundColor: palette[i], stack: 's',
          data: days.map(d => series.filter(r => r.bucket === d && r.channel === c).reduce((s, r) => s + Number(r.net_sales), 0)) })) },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }, y: { stacked: true, ticks: { callback: v => '$' + v } } } },
    });

    const low = ro.filter(r => r.status !== 'OK').sort((a, b) => (a.status === 'BELOW_ROP' ? 0 : 1) - (b.status === 'BELOW_ROP' ? 0 : 1) || String(a.order_by).localeCompare(String(b.order_by)));
    lowBox.replaceChildren(table([
      { key: 'sku', label: 'SKU', fmt: r => h('b', {}, r.sku) }, { key: 'name', label: 'Item' },
      { key: 'status', label: 'Status', fmt: r => badge(r.status) },
      { key: 'on_hand', label: 'On hand', num: true, fmt: r => qty(r.on_hand, r.uom) },
      { key: 'on_order', label: 'On order', num: true, fmt: r => qty(r.on_order, r.uom) },
      { key: 'rop', label: 'ROP', num: true, fmt: r => qty(r.rop, r.uom) },
      { key: 'suggested_qty', label: 'Suggested qty', num: true, fmt: r => h('b', {}, qty(r.suggested_qty, r.uom)) },
      { key: 'order_by', label: 'Order by', fmt: r => fmtDate(r.order_by) },
      { key: 'supplier_name', label: 'Source', fmt: r => r.supplier_name || 'Make in-house' },
    ], low, { empty: 'Everything is above its reorder point. 🌲', rowClass: r => r.status === 'BELOW_ROP' ? 'low' : '' }));

    queueBox.replaceChildren(table([
      { key: 'so_no', label: 'Order', fmt: r => h('a', { href: '#/orders?so=' + r.id }, r.so_no) },
      { key: 'customer', label: 'Customer', fmt: r => r.customers?.name },
      { key: 'requested_date', label: 'Due', fmt: r => h('span', { style: { whiteSpace: 'nowrap' } }, fmtDate(r.requested_date).replace(/, \d{4}/, '')) },
      { key: 'status', label: '', fmt: r => badge(r.status) },
    ], sos, { empty: 'No open orders.' }));
  }
  await load();
  return onChange(['sales', 'inventory_balances', 'sales_orders', 'purchase_orders', 'production_orders', 'ap_invoices', 'returns'], () => load().catch(() => {}), 600);
}

function greeting(p) {
  const hr = new Date().getHours();
  const part = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${(p.full_name || '').split(' ')[0] || 'there'}`;
}
