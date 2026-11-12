import { sb, q, rpc, getSettings, invalidateSettings } from '../lib/db.js';
import { h, money, qty, num, fmtDate, badge, table, modal, field, select, toast, run, loading, typeLabel, isoDate } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function reorder(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  let filt = 'action', tfilt = '';
  const picked = new Set();
  const setBox = h('div', { class: 'card' });
  const out = h('div');
  root.append(h('h1', {}, 'Reorder review'),
    h('p', { class: 'muted' }, 'Periodic manual review. Average daily usage comes from sales history; components get dependent demand by exploding sales through the BOM. Change any setting and every ROP / EOQ recalculates instantly.'),
    setBox, out);

  async function drawSettings() {
    const s = await getSettings(true);
    const f = {
      ordering_cost: h('input', { type: 'number', step: '0.01', min: 0, value: s.ordering_cost }),
      holding_cost_pct: h('input', { type: 'number', step: '0.01', min: 0.01, value: (s.holding_cost_pct * 100).toFixed(1) }),
      service_z: select([['1.28', '1.28 (90%)'], ['1.65', '1.65 (95%)'], ['2.05', '2.05 (98%)'], ['2.33', '2.33 (99%)']].concat([[String(s.service_z), `${s.service_z} (current)`]]), String(s.service_z)),
      review_period_days: h('input', { type: 'number', min: 1, value: s.review_period_days }),
      usage_window_days: h('input', { type: 'number', min: 14, max: 400, value: s.usage_window_days }),
    };
    setBox.replaceChildren(h('div', { class: 'card-h' }, h('h2', {}, 'Ordering rules'), h('span', { class: 'spacer' })),
      h('div', { class: 'fields' }, field('Ordering / setup cost per order ($)', f.ordering_cost), field('Holding cost (% of unit cost / yr)', f.holding_cost_pct),
        field('Service level z', f.service_z), field('Review period (days)', f.review_period_days), field('Usage history window (days)', f.usage_window_days)),
      isMgr ? h('button', { class: 'primary', onclick: e => run(e.target, async () => {
        await q(sb.from('settings').update({ ordering_cost: Number(f.ordering_cost.value), holding_cost_pct: Number(f.holding_cost_pct.value) / 100, service_z: Number(f.service_z.value),
          review_period_days: Number(f.review_period_days.value), usage_window_days: Number(f.usage_window_days.value), updated_at: new Date().toISOString() }).eq('id', 1));
        invalidateSettings(); toast('Settings saved — ROP and EOQ recalculated'); await drawTable(); }) }, 'Save & recalculate') : h('p', { class: 'hint' }, 'Managers can change these values.'));
  }

  let rows = [];
  async function drawTable(reload = true) {
    if (reload) { out.replaceChildren(loading('Calculating ROP & EOQ from sales history…')); rows = await rpc('fn_reorder_metrics'); }
    const list = rows.filter(r => (filt === 'all' || r.status !== 'OK') && (!tfilt || r.item_type === tfilt))
      .sort((a, b) => (a.status === 'BELOW_ROP' ? 0 : a.status === 'REVIEW' ? 1 : 2) - (b.status === 'BELOW_ROP' ? 0 : b.status === 'REVIEW' ? 1 : 2) || a.sku.localeCompare(b.sku));
    const made = r => ['finished', 'kit'].includes(r.item_type);
    const bar = h('div', { class: 'row', style: { margin: '14px 0 8px' } },
      select([['action', 'Needs action (below ROP or due within review period)'], ['all', 'All items']], filt, { onchange: e => { filt = e.target.value; drawTable(false); } }),
      select([['', 'All types'], ['raw', 'Raw materials'], ['finished', 'Finished goods'], ['kit', 'Gift sets'], ['resale', 'Resale']], tfilt, { style: { width: 'auto' }, onchange: e => { tfilt = e.target.value; drawTable(false); } }),
      h('div', { class: 'sp' }),
      h('button', { class: 'tan', onclick: e => run(e.target, () => createPOs(list.filter(r => picked.has(r.item_id) && !made(r)))) }, '🚚 Create POs (grouped by supplier)'),
      h('button', { class: 'tan', onclick: e => run(e.target, () => createMOs(list.filter(r => picked.has(r.item_id) && made(r)))) }, '🕯️ Create production orders'));
    out.replaceChildren(bar, table([
      { key: 'pick', label: h('input', { type: 'checkbox', title: 'Select all needing action', checked: list.some(r => r.status !== 'OK') && list.filter(r => r.status !== 'OK').every(r => picked.has(r.item_id)), onchange: e => { list.forEach(r => r.status !== 'OK' && (e.target.checked ? picked.add(r.item_id) : picked.delete(r.item_id))); drawTable(false); } }),
        fmt: r => h('input', { type: 'checkbox', checked: picked.has(r.item_id), onchange: e => e.target.checked ? picked.add(r.item_id) : picked.delete(r.item_id) }) },
      { key: 'sku', label: 'Item', fmt: r => h('div', {}, h('b', {}, r.sku), ' ', r.name, h('div', { class: 'muted' }, `${typeLabel(r.item_type)} · ${r.ordering_policy === 'MRP' ? 'MRP-planned' : 'ROP/EOQ'}`)) },
      { key: 'on_hand', label: 'On hand', num: true, fmt: r => qty(r.on_hand, r.uom) }, { key: 'on_order', label: 'On order', num: true, fmt: r => qty(r.on_order) },
      { key: 'avg_daily', label: 'Avg daily use', num: true, fmt: r => num(r.avg_daily, 2) }, { key: 'sd_daily', label: 'σ daily', num: true, fmt: r => num(r.sd_daily, 2) },
      { key: 'lead_time_days', label: 'LT (d)', num: true }, { key: 'safety_stock', label: 'Safety stock', num: true, fmt: r => qty(r.safety_stock) },
      { key: 'rop', label: 'ROP', num: true, fmt: r => h('b', {}, qty(r.rop)) }, { key: 'eoq', label: 'EOQ', num: true, fmt: r => qty(r.eoq) },
      { key: 'status', label: 'Status', fmt: r => badge(r.status) },
      { key: 'suggested_qty', label: 'Suggested', num: true, fmt: r => r.suggested_qty > 0 ? h('b', {}, qty(r.suggested_qty, r.uom)) : '—' },
      { key: 'order_by', label: 'Order by', fmt: r => r.order_by ? h('span', { style: { color: r.order_by <= isoDate() ? 'var(--red)' : '' } }, fmtDate(r.order_by)) : '—' },
      { key: 'src', label: 'Source', fmt: r => made(r) ? 'Make in-house' : r.supplier_name },
      { key: 'how', label: '', fmt: r => h('button', { class: 'sm ghost', onclick: () => explain(r) }, 'Show math') },
    ], list, { rowClass: r => r.status === 'BELOW_ROP' ? 'low' : r.status === 'REVIEW' ? 'warn' : '', scroll: true, empty: 'Nothing needs ordering right now. Switch to “All items” to see every calculation.' }));
  }

  function explain(r) {
    const H = r.holding_cost_unit;
    modal({ title: `${r.sku} · ${r.name} — the math`, wide: true, body: h('div', { class: 'stack' },
      h('div', { class: 'formula' }, `Average daily usage (last ${r.window_days} days${r.item_type === 'raw' ? ', exploded through BOMs of everything sold' : ''}):  d = ${num(r.avg_daily, 3)} ${r.uom}/day
Std. deviation of daily usage:  σd = ${num(r.sd_daily, 3)}
Lead time:  L = ${r.lead_time_days} days    Service-level z = ${r.z}`),
      h('div', { class: 'formula' }, `Safety stock = z × σd × √L = ${r.z} × ${num(r.sd_daily, 3)} × √${r.lead_time_days} = ${num(r.safety_stock, 2)}
Reorder point = d × L + SS = ${num(r.avg_daily, 3)} × ${r.lead_time_days} + ${num(r.safety_stock, 2)} = ${num(r.rop_calc, 2)}${r.rop_is_override ? `   (manual override in use: ${r.rop})` : ''}`),
      h('div', { class: 'formula' }, `Annual demand D = d × 365 = ${num(r.annual_demand, 1)}
Ordering cost S = ${money(r.ordering_cost)} per order    Holding cost H = ${(r.holding_pct * 100).toFixed(1)}% × ${money(r.unit_cost)} = ${money(H)} per unit per year
EOQ = √(2DS / H) = √(2 × ${num(r.annual_demand, 1)} × ${r.ordering_cost} ÷ ${num(H, 4)}) = ${num(r.eoq)}`),
      h('div', { class: 'formula' }, `Inventory position = on hand + on order = ${num(r.on_hand, 2)} + ${num(r.on_order, 2)} = ${num(r.inv_position, 2)}
Status: ${r.status === 'BELOW_ROP' ? 'position ≤ ROP → order now' : r.status === 'REVIEW' ? `position ≤ ROP + d × review period (${r.review_days} d) → order at this review` : 'position above ROP + review-period demand → no order'}
Suggested qty = max(EOQ, ROP + d × review − position, min order qty) = ${num(r.suggested_qty)}
Order-by date = today + (position − ROP) ÷ d = ${fmtDate(r.order_by)}`)),
      actions: [{ label: 'Close' }] });
  }

  async function createPOs(list) {
    if (!list.length) throw new Error('Tick at least one purchased item (raw material or resale).');
    if (!isMgr) throw new Error('Only managers create purchase orders.');
    const by = {};
    for (const r of list) { if (!r.supplier_id) throw new Error(`${r.sku} has no preferred supplier.`); (by[r.supplier_id] ||= []).push(r); }
    const made = [];
    for (const [sid, ls] of Object.entries(by)) {
      const res = await rpc('create_purchase_order', { p_supplier_id: Number(sid), p_ship_to: 'WKS', p_lines: ls.map(r => ({ item_id: r.item_id, qty: Math.max(r.suggested_qty, r.eoq, 1) })), p_notes: 'From reorder review' });
      made.push(res.po_no);
    }
    picked.clear(); toast(`Created ${made.join(', ')} (Order Sent)`); await drawTable();
  }
  async function createMOs(list) {
    if (!list.length) throw new Error('Tick at least one made item (finished good or gift set).');
    const made = [];
    for (const r of list) {
      const res = await rpc('create_production_order', { p_item_id: r.item_id, p_qty: Math.max(r.suggested_qty, 12), p_location: 'WKS' });
      made.push(res.mo_no);
    }
    picked.clear(); toast(`Created ${made.join(', ')} — see Production`); await drawTable();
  }

  await drawSettings(); await drawTable();
  return onChange(['inventory_balances', 'purchase_orders', 'production_orders', 'settings'], () => drawTable().catch(() => {}), 1500);
}
