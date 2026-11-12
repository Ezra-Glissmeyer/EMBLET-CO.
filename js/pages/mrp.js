import { sb, q, rpc, getItems } from '../lib/db.js';
import { h, money, qty, num, fmtDate, badge, table, modal, select, field, toast, run, loading, empty, typeLabel, isoDate } from '../lib/ui.js';

export async function loadRun(runId) {
  const [lines, items] = await Promise.all([q(sb.from('mrp_lines').select('*').eq('run_id', runId).order('llc').order('item_id').order('week_no')), getItems()]);
  const by = new Map();
  for (const l of lines) {
    if (!by.has(l.item_id)) by.set(l.item_id, { item: items.find(i => i.id === l.item_id), llc: l.llc, weeks: [] });
    by.get(l.item_id).weeks.push(l);
  }
  return [...by.values()];
}

export function mrpGrid(rec, onPeg) {
  const w = rec.weeks;
  const row = (label, key, cls) => h('tr', {}, h('td', {}, label), ...w.map(x => {
    const v = Number(x[key]);
    const c = typeof cls === 'function' ? cls(x, v) : '';
    return h('td', { class: 'num ' + c }, v ? qty(v) : (key === 'proj_on_hand' ? '0' : '·'));
  }));
  const it = rec.item;
  const past = w.some(x => x.past_due);
  return h('div', { class: 'mrp-item' },
    h('div', { class: 'hd' }, h('span', { class: 'lvl' }, 'Level ' + rec.llc), h('b', {}, `${it.sku} · ${it.name}`),
      h('span', { class: 'muted' }, `${typeLabel(it.item_type)} · ${it.uom} · lead time ${it.lead_time_days} d · ${['finished', 'kit'].includes(it.item_type) ? 'make' : 'buy'}`),
      past ? badge('BELOW_ROP', 'Release date already past!') : null, h('span', { class: 'sp' }),
      h('button', { class: 'sm', onclick: () => onPeg(it) }, 'Pegging ⟶ which orders?')),
    h('div', { style: { overflowX: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Week of'), ...w.map(x => h('th', { class: 'num' }, `Wk ${x.week_no} · ${fmtDate(x.week_start).replace(/, \d{4}/, '')}`)))),
      h('tbody', {},
        row('Gross requirements', 'gross_req'),
        row('Scheduled receipts', 'sched_receipts'),
        row('Projected on hand', 'proj_on_hand', (x, v) => v < 0 ? 'neg' : ''),
        row('Net requirements', 'net_req', (x, v) => v > 0 ? 'neg' : ''),
        row('Planned order receipt', 'planned_receipt', (x, v) => v > 0 ? 'por' : ''),
        h('tr', {}, h('td', {}, 'Planned order release'), ...w.map(x => h('td', { class: 'num ' + (x.planned_release > 0 ? 'por' : '') }, x.planned_release > 0 ? qty(x.planned_release) : '·'))),
        h('tr', {}, h('td', {}, 'Order-by (release) date'), ...w.map(x => h('td', { class: 'num ' + (x.past_due ? 'past' : '') }, x.release_date ? fmtDate(x.release_date).replace(/, \d{4}/, '') + (x.past_due ? ' ⚠' : '') : '·')))))));
}

export async function showPegging(runId, it) {
  const rows = await q(sb.from('mrp_pegging').select('*').eq('run_id', runId).eq('item_id', it.id).order('need_date'));
  modal({ title: `Pegging — ${it.sku} · ${it.name}`, wide: true, body: h('div', {},
    h('p', { class: 'muted' }, 'Gross demand for this item traced back to its source, through every BOM level (gift set → candle → raw material).'),
    table([{ key: 'source_type', label: 'Source', fmt: r => badge('x', r.source_type) }, { key: 'source_no', label: 'Document' }, { key: 'customer_name', label: 'Customer' },
      { key: 'path', label: 'BOM path' }, { key: 'need_date', label: 'Needed by', fmt: r => fmtDate(r.need_date) }, { key: 'week_no', label: 'Wk', num: true },
      { key: 'qty', label: 'Qty', num: true, fmt: r => qty(r.qty, it.uom) }], rows, { empty: 'No demand pegged to this item.' })),
    actions: [{ label: 'Close' }] });
}

export async function convertPlanned(list, isMgr) {
  const buy = list.filter(p => ['raw', 'resale'].includes(p.item.item_type)), make = list.filter(p => !['raw', 'resale'].includes(p.item.item_type));
  if (buy.length && !isMgr) throw new Error('Only managers can create purchase orders.');
  const made = [];
  const bySup = {};
  for (const p of buy) { if (!p.item.preferred_supplier_id) throw new Error(p.item.sku + ' has no preferred supplier'); (bySup[p.item.preferred_supplier_id] ||= []).push(p); }
  for (const [sid, ps] of Object.entries(bySup)) {
    const r = await rpc('create_purchase_order', { p_supplier_id: Number(sid), p_ship_to: 'WKS', p_lines: ps.map(p => ({ item_id: p.item.id, qty: p.qty })), p_notes: 'From MRP planned orders' });
    made.push(r.po_no);
  }
  for (const p of make) {
    const start = new Date(Math.max(Date.now() + 3600e3, new Date(p.release + 'T08:00:00').getTime()));
    const r = await rpc('create_production_order', { p_item_id: p.item.id, p_qty: p.qty, p_location: 'WKS', p_planned_start: start.toISOString(),
      p_planned_finish: new Date(start.getTime() + Math.max(1, p.item.lead_time_days) * 864e5).toISOString(), p_notes: 'From MRP planned order' });
    made.push(r.mo_no);
  }
  return made;
}

export function plannedList(recs) {
  return recs.flatMap(r => r.weeks.filter(w => w.planned_receipt > 0).map(w => ({ key: `${r.item.id}-${w.week_no}`, item: r.item, llc: r.llc, week: w.week_no, qty: Number(w.planned_receipt), release: w.release_date, past: w.past_due, need: w.week_start })));
}

export default async function mrp(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  const weeks = select([['4', '4 weeks'], ['6', '6 weeks'], ['8', '8 weeks']], '4');
  const lot = select([['LFL', 'Lot-for-lot'], ['EOQ', 'EOQ lot sizing']], 'LFL');
  const show = select([['planned', 'Items with planned orders'], ['all', 'All items with activity']], 'planned');
  const search = h('input', { type: 'search', placeholder: 'Filter item…' });
  const summary = h('div'), grid = h('div');
  let runId = null, recs = [];
  const picked = new Set();
  root.append(h('h1', {}, 'MRP — material requirements plan'),
    h('p', { class: 'muted' }, 'Gross requirements = confirmed sales orders (by requested date) exploded through the BOM — recursively for gift sets. Net = gross − projected on hand − scheduled receipts (open POs & production orders), netted level by level and carried week to week. Release date = need date − lead time.'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, field('Horizon', weeks), field('Lot sizing', lot), field('Show', show), field('Find', search),
      h('button', { class: 'primary', onclick: e => run(e.target, runIt) }, '▶ Run MRP'))), summary, grid);
  show.addEventListener('change', draw); search.addEventListener('input', draw);

  async function runIt() {
    const r = await rpc('run_mrp', { p_weeks: Number(weeks.value), p_lot_rule: lot.value, p_demand_mult: 1, p_include_forecast: false, p_label: 'MRP screen' });
    runId = r.run_id; recs = await loadRun(runId); picked.clear(); draw();
    toast(`MRP run #${r.run_id}: ${r.planned_orders} planned orders across ${r.items_planned} items${r.past_due ? `, ${r.past_due} already past due` : ''}`);
  }
  function draw() {
    const planned = plannedList(recs);
    summary.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Planned orders'), h('span', { class: 'muted' }, `run #${runId} · ${lot.value === 'EOQ' ? 'EOQ' : 'lot-for-lot'}`), h('span', { class: 'spacer' }),
      h('button', { class: 'tan', onclick: e => run(e.target, async () => {
        const sel = planned.filter(p => picked.has(p.key)); if (!sel.length) throw new Error('Tick planned orders to convert.');
        const made = await convertPlanned(sel, isMgr); toast('Created ' + made.join(', ')); await runIt(); }) }, 'Convert selected → POs / production orders')),
      table([
        { key: 'pick', label: '', fmt: p => h('input', { type: 'checkbox', checked: picked.has(p.key), onchange: e => e.target.checked ? picked.add(p.key) : picked.delete(p.key) }) },
        { key: 'llc', label: 'Lvl', num: true }, { key: 'item', label: 'Item', fmt: p => `${p.item.sku} · ${p.item.name}` },
        { key: 'type', label: 'Action', fmt: p => ['finished', 'kit'].includes(p.item.item_type) ? badge('x', 'Make') : badge('tan', 'Buy') },
        { key: 'qty', label: 'Qty', num: true, fmt: p => h('b', {}, qty(p.qty, p.item.uom)) },
        { key: 'need', label: 'Needed (week of)', fmt: p => fmtDate(p.need) },
        { key: 'release', label: 'Order-by date', fmt: p => h('span', { class: p.past ? 'badge red' : '' }, fmtDate(p.release) + (p.past ? ' — PAST DUE' : '')) },
      ], planned, { rowClass: p => p.past ? 'low' : '', empty: 'No planned orders — on-hand and scheduled receipts cover all confirmed demand.', scroll: true })));
    const s = search.value.trim().toLowerCase();
    const list = recs.filter(r => (show.value === 'all' || r.weeks.some(w => w.planned_receipt > 0)) && (!s || (r.item.sku + r.item.name).toLowerCase().includes(s)));
    grid.replaceChildren(h('h2', { style: { marginTop: '18px' } }, 'Time-phased records'), ...(list.length ? list.map(r => mrpGrid(r, it => showPegging(runId, it))) : [empty('No items to show.')]));
  }
  grid.append(loading('Running MRP…'));
  await run(null, runIt);
}
