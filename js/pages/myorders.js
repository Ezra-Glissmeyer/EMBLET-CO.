import { sb, q, rpc } from '../lib/db.js';
import { h, money, qty, fmtDate, badge, empty, run, toast, locName, loading, confirmBox } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function myorders(root) {
  const list = h('div', {}, loading());
  root.append(h('h1', {}, 'My orders'), h('p', { class: 'muted' }, 'Status updates here automatically when our team fulfills your order.'), list);
  const cat = Object.fromEntries((await q(sb.from('v_catalog').select('id, name'))).map(c => [c.id, c.name]));
  async function load() {
    const rows = await q(sb.from('sales_orders').select('id, so_no, status, order_date, requested_date, location_code, channel, so_lines(item_id, qty_ordered, qty_fulfilled, unit_price)').order('id', { ascending: false }).limit(50));
    list.replaceChildren(...(rows.length ? rows.map(o => h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h3', {}, o.so_no), badge(o.status), h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, `${o.channel === 'ONLINE_PICKUP' ? 'Pickup' : 'Order'} at ${locName(o.location_code)} · ${fmtDate(o.requested_date)}`)),
      ...o.so_lines.map(l => h('div', { class: 'row', style: { padding: '3px 0' } }, h('span', { class: 'sp' }, cat[l.item_id] || 'Item #' + l.item_id),
        h('span', { class: 'muted' }, l.qty_fulfilled > 0 ? `${qty(l.qty_fulfilled)} of ${qty(l.qty_ordered)} ready/picked up` : `${qty(l.qty_ordered)} ordered`), h('span', { style: { width: '80px', textAlign: 'right' } }, money(l.qty_ordered * l.unit_price)))),
      o.status === 'ORDER_PLACED' ? h('div', { class: 'row end', style: { marginTop: '8px' } }, h('button', { class: 'sm danger', onclick: e => run(e.target, async () => {
        if (!await confirmBox('Cancel this order?', `Cancel ${o.so_no}?`, 'Cancel order', true)) return;
        await rpc('cancel_sales_order', { p_so_id: o.id, p_reason: 'Cancelled by customer' }); toast('Order cancelled'); load(); }) }, 'Cancel order')) : null))
      : [empty('No orders yet — browse the shop to place a pickup order.', '🌲')]));
  }
  await load();
  return onChange(['sales_orders', 'so_lines'], () => load().catch(() => {}), 300);
}
