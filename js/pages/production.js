import { sb, q, rpc, getItems, getReasons } from '../lib/db.js';
import { h, money, qty, pct, num, fmtDT, fmtDate, badge, table, tabs, modal, field, select, toast, run, kpi, chart, isoDate, addDays, loading, palette, locName } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

const localDT = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

export default async function production(root, ctx) {
  const [items, scrapReasons] = await Promise.all([getItems(), getReasons('SCRAP')]);
  const made = items.filter(i => ['finished', 'kit'].includes(i.item_type) && i.active);
  let view = ctx.params.get('tab') || 'orders';
  const body = h('div');
  root.append(h('div', { class: 'row' }, h('h1', {}, 'Production'), h('div', { class: 'sp' }), h('button', { class: 'primary', onclick: () => newMO() }, '+ New production order')),
    h('p', { class: 'muted' }, 'Create → Issue (consumes components per BOM into Work in Process) → Complete (good units go to finished goods at actual cost = components issued ÷ good units, so scrap raises unit cost).'),
    tabs([['orders', 'Open orders'], ['done', 'Completed'], ['report', 'Production report']], view, k => { view = k; render(); }), body);
  const render = () => ({ orders: () => list(['PLANNED', 'IN_PROGRESS']), done: () => list(['COMPLETED', 'CANCELLED']), report })[view]().catch(e => body.replaceChildren(h('div', { class: 'callout bad' }, e.message)));

  async function list(statuses) {
    body.replaceChildren(loading());
    const rows = await q(sb.from('production_orders').select('*, items(sku, name, uom)').in('status', statuses).order(statuses.includes('PLANNED') ? 'planned_start' : 'actual_finish', { ascending: statuses.includes('PLANNED') }).limit(200));
    body.replaceChildren(table([
      { key: 'mo_no', label: 'Order', fmt: r => h('b', {}, r.mo_no) }, { key: 'item', label: 'Item', fmt: r => `${r.items.sku} · ${r.items.name}` },
      { key: 'qty_planned', label: 'Qty', num: true, fmt: r => qty(r.qty_planned) }, { key: 'location_code', label: 'Loc' },
      { key: 'ps', label: 'Planned', fmt: r => `${fmtDT(r.planned_start)} → ${fmtDT(r.planned_finish)}` },
      { key: 'act', label: 'Actual', fmt: r => r.actual_start ? `${fmtDT(r.actual_start)}${r.actual_finish ? ' → ' + fmtDT(r.actual_finish) : ''}` : '—' },
      ...(statuses.includes('COMPLETED') ? [
        { key: 'g', label: 'Good / scrap', num: true, fmt: r => r.status === 'COMPLETED' ? `${qty(r.qty_good)} / ${qty(r.qty_scrap)}` : '' },
        { key: 'sr', label: 'Scrap reason', fmt: r => r.scrap_reason || '' },
        { key: 'uc', label: 'Actual vs std', num: true, fmt: r => r.actual_unit_cost ? h('span', { style: { color: r.actual_unit_cost > r.std_unit_cost ? 'var(--red)' : 'var(--green)' } }, `${money(r.actual_unit_cost)} / ${money(r.std_unit_cost)}`) : '' },
        { key: 'lot_no', label: 'Lot' }] : [{ key: 'cc', label: 'Issued cost', num: true, fmt: r => r.status === 'IN_PROGRESS' ? money(r.component_cost) : '' }]),
      { key: 'status', label: 'Status', fmt: r => badge(r.status) },
      { key: 'a', label: '', fmt: r => r.status === 'PLANNED' ? h('div', { class: 'row' },
          h('button', { class: 'sm primary', onclick: e => run(e.target, async () => { const res = await rpc('issue_production_order', { p_mo_id: r.id }); toast(`${res.mo_no} issued — ${money(res.component_cost)} of materials to WIP (lot ${res.lot_no})`); render(); }) }, 'Issue materials'),
          h('button', { class: 'sm ghost', onclick: e => run(e.target, async () => { await rpc('cancel_production_order', { p_mo_id: r.id }); toast('Cancelled'); render(); }) }, 'Cancel'))
        : r.status === 'IN_PROGRESS' ? h('button', { class: 'sm primary', onclick: () => complete(r) }, 'Complete…') : '' },
    ], rows, { empty: statuses.includes('PLANNED') ? 'No open production orders. Use MRP or Reorder Review to plan some.' : 'No completed orders yet.', scroll: true }));
  }

  function complete(r) {
    const good = h('input', { type: 'number', min: 0, value: r.qty_started || r.qty_planned });
    const scrap = h('input', { type: 'number', min: 0, value: 0 });
    const reason = select([['', '— no scrap —'], ...scrapReasons.map(s => [s.code, `${s.code} — ${s.description}`])], '');
    const st = h('input', { type: 'datetime-local', value: localDT(r.actual_start || r.planned_start) });
    const fn = h('input', { type: 'datetime-local', value: localDT(new Date()) });
    const preview = h('div', { class: 'callout' });
    const upd = () => {
      const g = Number(good.value) || 0, s = Number(scrap.value) || 0;
      preview.textContent = g + s !== Number(r.qty_started) ? `Good + scrap must equal ${qty(r.qty_started)} started (now ${g + s}).`
        : `Unit cost = ${money(r.component_cost)} ÷ ${g} good = ${money(g ? r.component_cost / g : 0)} · FPY ${pct(g / r.qty_started * 100)}`;
    };
    good.addEventListener('input', () => { scrap.value = Math.max(0, r.qty_started - (Number(good.value) || 0)); upd(); });
    scrap.addEventListener('input', () => { good.value = Math.max(0, r.qty_started - (Number(scrap.value) || 0)); upd(); });
    upd();
    modal({ title: `Complete ${r.mo_no} · ${r.items.name}`, body: h('div', {},
      h('div', { class: 'fields' }, field('Qty started', h('input', { value: qty(r.qty_started), disabled: true })), field('Completed good', good), field('Scrapped / rework', scrap)),
      field('Scrap reason code', reason), h('div', { class: 'fields' }, field('Actual start', st), field('Actual finish', fn)), preview),
      actions: [{ label: 'Cancel' }, { label: 'Complete & receive to stock', class: 'primary', onClick: async () => {
        const res = await rpc('complete_production_order', { p_mo_id: r.id, p_qty_good: Number(good.value), p_qty_scrap: Number(scrap.value),
          p_scrap_reason: reason.value || null, p_actual_start: new Date(st.value).toISOString(), p_actual_finish: new Date(fn.value).toISOString() });
        toast(`${res.mo_no} complete: ${qty(res.qty_good)} good at ${money(res.actual_unit_cost)} (std ${money(res.std_unit_cost)})`); render(); return true; } }] });
  }

  function newMO(prefill = {}) {
    const it = select(made.map(i => [i.id, `${i.sku} · ${i.name} (batch ${i.batch_size || '—'})`]), prefill.item_id || made[0].id);
    const n = h('input', { type: 'number', min: 1, value: prefill.qty || made[0].batch_size || 48 });
    it.addEventListener('change', () => { n.value = made.find(m => m.id == it.value)?.batch_size || n.value; });
    const loc = select([['WKS', 'Workshop – Orem'], ['WHS', 'Warehouse – Springville (kit assembly)']], 'WKS');
    const st = h('input', { type: 'datetime-local', value: localDT(Date.now() + 3600e3) });
    const fn = h('input', { type: 'datetime-local', value: localDT(Date.now() + 9 * 3600e3) });
    modal({ title: 'New production order', body: h('div', {}, field('Item to make', it), h('div', { class: 'fields' }, field('Quantity', n), field('Location', loc)),
      h('div', { class: 'fields' }, field('Planned start', st), field('Planned finish', fn))),
      actions: [{ label: 'Cancel' }, { label: 'Create order', class: 'primary', onClick: async () => {
        const r = await rpc('create_production_order', { p_item_id: Number(it.value), p_qty: Number(n.value), p_location: loc.value,
          p_planned_start: new Date(st.value).toISOString(), p_planned_finish: new Date(fn.value).toISOString() });
        toast(`Created ${r.mo_no} — issue it when you start pouring.`); view = 'orders'; render(); return true; } }] });
  }

  async function report() {
    const from = h('input', { type: 'date', value: addDays(isoDate(), -90) }), to = h('input', { type: 'date', value: isoDate() });
    const out = h('div', {}, loading());
    const go = async () => {
      const m = await rpc('fn_production_metrics', { p_from: from.value, p_to: to.value });
      const wk = h('canvas', { height: 110 }), rs = h('canvas', { height: 160 });
      out.replaceChildren(
        h('div', { class: 'kpis' },
          kpi('First-pass yield', pct(m.first_pass_yield_pct), `${num(m.units_good)} good of ${num(m.units_started)} started`, 'good'),
          kpi('Scrap rate', pct(m.scrap_rate_pct), `${num(m.units_scrap)} units`, m.scrap_rate_pct > 5 ? 'bad' : ''),
          kpi('Throughput', `${num(m.throughput_units_per_hr, 1)} /hr`, 'good units per production hour'),
          kpi('Avg cycle time', `${num(m.avg_cycle_time_hrs, 1)} h`, `${m.orders} orders completed`),
          kpi('On-time completion', pct(m.on_time_pct), 'actual finish ≤ planned finish', m.on_time_pct < 70 ? 'warn' : ''),
          kpi('Cost variance', money(m.cost_variance_total), `avg ${pct(m.avg_cost_variance_pct)} vs standard`, m.cost_variance_total > 0 ? 'warn' : 'good')),
        h('div', { class: 'grid g2' },
          h('div', { class: 'card' }, h('h3', {}, 'Weekly output & first-pass yield'), wk),
          h('div', { class: 'card' }, h('h3', {}, 'Scrap by reason'), rs,
            table([{ key: 'reason', label: 'Reason' }, { key: 'description', label: '' }, { key: 'qty', label: 'Units', num: true, fmt: r => qty(r.qty) }, { key: 'pct_of_started', label: '% of started', num: true, fmt: r => pct(r.pct_of_started, 2) }], m.scrap_by_reason, { empty: 'No scrap in this range.' }))),
        h('div', { class: 'card' }, h('h3', {}, 'By item — actual vs standard unit cost'),
          table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'orders', label: 'Orders', num: true }, { key: 'good', label: 'Good', num: true, fmt: r => qty(r.good) },
            { key: 'scrap', label: 'Scrap', num: true, fmt: r => qty(r.scrap) }, { key: 'fpy_pct', label: 'FPY', num: true, fmt: r => pct(r.fpy_pct) },
            { key: 'units_per_hr', label: 'Units/hr', num: true }, { key: 'std_cost', label: 'Std cost', num: true, fmt: r => money(r.std_cost) },
            { key: 'avg_actual_cost', label: 'Actual cost', num: true, fmt: r => money(r.avg_actual_cost) },
            { key: 'variance_pct', label: 'Variance', num: true, fmt: r => h('b', { style: { color: r.variance_pct > 0 ? 'var(--red)' : 'var(--green)' } }, pct(r.variance_pct)) }], m.by_item)));
      chart(wk, { data: { labels: m.by_week.map(w => fmtDate(w.week)), datasets: [
        { type: 'bar', label: 'Good', data: m.by_week.map(w => w.good), backgroundColor: palette[2], stack: 'u', yAxisID: 'y' },
        { type: 'bar', label: 'Scrap', data: m.by_week.map(w => w.scrap), backgroundColor: palette[5], stack: 'u', yAxisID: 'y' },
        { type: 'line', label: 'FPY %', data: m.by_week.map(w => w.fpy_pct), borderColor: palette[0], yAxisID: 'y2', tension: .3 }] },
        options: { scales: { y: { stacked: true, title: { display: true, text: 'units' } }, x: { stacked: true }, y2: { position: 'right', min: 85, max: 100, grid: { display: false } } }, plugins: { legend: { position: 'bottom' } } } });
      chart(rs, { type: 'doughnut', data: { labels: m.scrap_by_reason.map(r => r.reason), datasets: [{ data: m.scrap_by_reason.map(r => r.qty), backgroundColor: palette }] }, options: { plugins: { legend: { position: 'right' } } } });
    };
    body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, field('From', from), field('To', to), h('button', { class: 'primary', onclick: e => run(e.target, go) }, 'Run report'))), out);
    await go();
  }

  render();
  if (ctx.params.get('new')) newMO({ item_id: Number(ctx.params.get('new')), qty: Number(ctx.params.get('qty')) || undefined });
  return onChange(['production_orders'], () => { if (view !== 'report') render(); }, 500);
}
