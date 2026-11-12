import { rpc } from '../lib/db.js';
import { h, qty, num, fmtDate, badge, table, toast, run, chart, palette, loading, kpi, empty } from '../lib/ui.js';
import { loadRun, mrpGrid, showPegging, plannedList, convertPlanned } from './mrp.js';

export default async function planner(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  let mult = 1, runId = null, timer = null, busy = false, pending = false;
  const slider = h('input', { type: 'range', min: -30, max: 80, step: 5, value: 0, style: { width: '100%' } });
  const sval = h('b', { style: { fontSize: '1.6rem', fontFamily: 'var(--serif)' } }, '+0%');
  const tiles = h('div', { class: 'kpis' });
  const cv = h('canvas', { height: 95 });
  const alerts = h('div'), detail = h('div');
  root.append(
    h('div', { class: 'shop-hero', style: { marginBottom: '16px' } }, h('h1', {}, '❄ Holiday Readiness Planner'),
      h('p', {}, 'Forecasts the next 8 weeks from last year\'s same weeks × this year\'s growth trend, adds confirmed sales orders, then re-runs the full MRP explosion (gift sets → candles → wax, oils, jars…) to show what runs out and when. Drag the slider to stress-test demand.')),
    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Weekly demand: last year vs forecast'), h('span', { class: 'spacer' })), cv),
      h('div', { class: 'card' }, h('h2', {}, 'What-if: walk-in demand'), h('div', { class: 'row' }, sval, h('span', { class: 'muted' }, 'vs. baseline forecast')), slider,
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('small', {}, '−30%'), h('small', {}, 'baseline'), h('small', {}, '+80%')),
        h('p', { class: 'hint' }, 'Confirmed sales orders stay fixed; the multiplier scales the storefront forecast. MRP re-runs automatically.'))),
    tiles, alerts, detail);

  slider.addEventListener('input', () => {
    mult = 1 + Number(slider.value) / 100; sval.textContent = (slider.value >= 0 ? '+' : '') + slider.value + '%';
    clearTimeout(timer); timer = setTimeout(() => go(), 450);
  });

  async function go() {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      alerts.replaceChildren(loading('Re-running MRP with forecast…'));
      const [fc, r] = await Promise.all([rpc('fn_forecast', { p_weeks: 8, p_mult: mult }), rpc('run_mrp', { p_weeks: 8, p_lot_rule: 'LFL', p_demand_mult: mult, p_include_forecast: true, p_label: `Planner x${mult.toFixed(2)}` })]);
      runId = r.run_id;
      const recs = await loadRun(runId);
      const wk = [...Array(8)].map((_, i) => i + 1);
      const ly = wk.map(w => fc.filter(f => f.week_no === w).reduce((s, f) => s + Number(f.ly_qty), 0));
      const fcs = wk.map(w => fc.filter(f => f.week_no === w).reduce((s, f) => s + Number(f.forecast), 0));
      const trend = fc[0]?.trend ?? 1;
      const labels = wk.map(w => 'Wk ' + w + ' · ' + fmtDate(fc.find(f => f.week_no === w)?.week_start).replace(/, \d{4}/, ''));
      chart(cv, { type: 'bar', data: { labels, datasets: [
        { label: 'Same weeks last year (units)', data: ly, backgroundColor: palette[1] },
        { label: `Forecast (× trend ${num(trend, 2)} × ${mult.toFixed(2)})`, data: fcs, backgroundColor: palette[0] }] },
        options: { plugins: { legend: { position: 'bottom' } }, animation: { duration: 250 } } });

      const planned = plannedList(recs);
      const raw = recs.filter(x => ['raw', 'resale'].includes(x.item.item_type));
      const runouts = raw.map(x => {
        const first = x.weeks.find(w => w.net_req > 0);
        if (!first) return null;
        const p = planned.filter(pp => pp.item.id === x.item.id);
        return { rec: x, item: x.item, week: first.week_no, start: first.week_start, short: Number(first.net_req),
          total: p.reduce((s, pp) => s + pp.qty, 0), release: p[0]?.release, past: p.some(pp => pp.past), planned: p };
      }).filter(Boolean).sort((a, b) => a.week - b.week || (b.past - a.past));
      const make = planned.filter(p => ['finished', 'kit'].includes(p.item.item_type));
      tiles.replaceChildren(
        kpi('Forecast units (8 wk)', num(fcs.reduce((a, b) => a + b, 0)), `last year ${num(ly.reduce((a, b) => a + b, 0))} · trend ×${num(trend, 2)}`),
        kpi('Materials that run out', num(runouts.length), runouts.length ? `first: ${runouts[0].item.name} in wk ${runouts[0].week}` : 'covered', runouts.length ? 'bad' : 'good'),
        kpi('Too late to order', num(runouts.filter(r => r.past).length), 'order-by date already past → expedite', runouts.some(r => r.past) ? 'bad' : 'good'),
        kpi('Production runs needed', num(make.length), `${num(make.reduce((s, p) => s + p.qty, 0))} units to make`, make.length ? 'warn' : ''));
      const picked = new Set(runouts.filter(r => r.past).flatMap(r => r.planned.map(p => p.key)));
      alerts.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Raw materials that will run out'), h('span', { class: 'spacer' }),
        h('button', { class: 'tan', onclick: e => run(e.target, async () => { const sel = planned.filter(p => picked.has(p.key)); if (!sel.length) throw new Error('Tick rows to order.'); const m = await convertPlanned(sel, isMgr); toast('Created ' + m.join(', ')); await go(); }) }, 'Order selected now')),
        table([
          { key: 'pick', label: '', fmt: r => h('input', { type: 'checkbox', checked: r.planned.every(p => picked.has(p.key)), onchange: e => r.planned.forEach(p => e.target.checked ? picked.add(p.key) : picked.delete(p.key)) }) },
          { key: 'item', label: 'Material', fmt: r => h('div', {}, h('b', {}, r.item.sku), ' ', r.item.name) },
          { key: 'week', label: 'Runs out', fmt: r => h('b', { style: { color: r.week <= 2 ? 'var(--red)' : '' } }, `Week ${r.week} (${fmtDate(r.start)})`) },
          { key: 'short', label: 'First shortfall', num: true, fmt: r => qty(r.short, r.item.uom) },
          { key: 'total', label: 'Total to order (8 wk)', num: true, fmt: r => h('b', {}, qty(r.total, r.item.uom)) },
          { key: 'lt', label: 'Lead time', num: true, fmt: r => r.item.lead_time_days + ' d' },
          { key: 'release', label: 'Order by', fmt: r => r.past ? badge('BELOW_ROP', fmtDate(r.release) + ' — too late, expedite!') : fmtDate(r.release) },
          { key: 'peg', label: '', fmt: r => h('button', { class: 'sm', onclick: () => showPegging(runId, r.item) }, 'Why?') },
        ], runouts, { rowClass: r => r.past ? 'low' : '', empty: 'No raw material shortfalls in the next 8 weeks at this demand level. 🌲' })));
      detail.replaceChildren(h('details', { class: 'card' }, h('summary', {}, h('b', {}, `Show the full MRP records (${planned.length} planned orders)`)),
        ...(recs.filter(r => r.weeks.some(w => w.planned_receipt > 0)).map(r => mrpGrid(r, it => showPegging(runId, it)))), recs.length ? null : empty('No records.')));
    } finally {
      busy = false;
      if (pending) { pending = false; go(); }
    }
  }
  await run(null, go);
}
