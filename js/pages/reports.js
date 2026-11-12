import { sb, q, rpc } from '../lib/db.js';
import { h, money, qty, num, pct, fmtDate, table, field, select, run, loading, chart, palette, isoDate, addDays, badge, locName } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function reports(root) {
  const from = h('input', { type: 'date', value: addDays(isoDate(), -364) }), to = h('input', { type: 'date', value: isoDate() });
  const grain = select([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], 'month');
  const out = h('div');
  root.append(h('h1', {}, 'Management reports'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, field('From', from), field('To', to), field('Sales by', grain), h('button', { class: 'primary', onclick: e => run(e.target, load) }, 'Run reports'))), out);

  async function load() {
    out.replaceChildren(loading());
    const [series, itemsales, ret, ro, score, grid] = await Promise.all([
      rpc('fn_sales_summary', { p_from: from.value, p_to: to.value, p_grain: grain.value }),
      rpc('fn_item_sales', { p_from: from.value, p_to: to.value }),
      rpc('fn_returns_by_reason', { p_from: from.value, p_to: to.value }),
      rpc('fn_reorder_metrics'),
      q(sb.from('v_supplier_scorecard').select('name, quoted_lead_days, avg_actual_lead, avg_days_late, on_time_pct, fill_rate_pct, rating')),
      rpc('fn_inventory_grid')]);
    const c1 = h('canvas', { height: 90 }), c2 = h('canvas', { height: 170 }), c3 = h('canvas', { height: 170 }), c4 = h('canvas', { height: 170 }), c5 = h('canvas', { height: 170 });
    // series
    const buckets = [...new Set(series.map(r => r.bucket))].sort();
    const locs = [...new Set(series.map(r => r.location_code))], chans = [...new Set(series.map(r => r.channel))];
    const sumBy = (k) => Object.entries(series.reduce((m, r) => { m[r[k]] = (m[r[k]] || 0) + Number(r.net_sales); return m; }, {}));
    const tot = series.reduce((s, r) => s + Number(r.net_sales), 0);
    const top = [...itemsales].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
    const topU = [...itemsales].sort((a, b) => b.units - a.units).slice(0, 10);
    const slow = [...itemsales].sort((a, b) => a.units - b.units).slice(0, 8);
    const low = ro.filter(r => r.status !== 'OK');
    const qual = ret.filter(r => r.is_quality);
    const byReason = Object.entries(ret.reduce((m, r) => { m[r.reason_code] = (m[r.reason_code] || 0) + Number(r.qty); return m; }, {})).sort((a, b) => b[1] - a[1]);
    const byFamily = Object.entries(itemsales.reduce((m, r) => { const f = r.scent_family || 'accessory'; m[f] ||= { rev: 0, gp: 0 }; m[f].rev += Number(r.revenue); m[f].gp += Number(r.gross_profit); return m; }, {}));
    const qualByItem = Object.values(qual.reduce((m, r) => { m[r.sku] ||= { sku: r.sku, name: r.name, qty: 0, reasons: {} }; m[r.sku].qty += Number(r.qty); m[r.sku].reasons[r.reason_code] = (m[r.sku].reasons[r.reason_code] || 0) + Number(r.qty); return m; }, {})).sort((a, b) => b.qty - a.qty);
    const sold = Object.fromEntries(itemsales.map(i => [i.item_id, i.units]));

    out.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, `Net sales by ${grain.value}`), h('span', { class: 'spacer' }), h('b', {}, money(tot, true))), c1),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Sales by location'), c2, table([{ key: 0, label: 'Location', fmt: r => locName(r[0]) }, { key: 1, label: 'Net sales', num: true, fmt: r => money(r[1]) }, { key: 2, label: 'Share', num: true, fmt: r => pct(r[1] / tot * 100) }], sumBy('location_code'))),
        h('div', { class: 'card' }, h('h2', {}, 'Sales by channel'), c3, table([{ key: 0, label: 'Channel', fmt: r => r[0].replace('_', ' ') }, { key: 1, label: 'Net sales', num: true, fmt: r => money(r[1]) }, { key: 2, label: 'Share', num: true, fmt: r => pct(r[1] / tot * 100) }], sumBy('channel')))),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Top sellers by revenue'), table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'units', label: 'Units', num: true, fmt: r => num(r.units) }, { key: 'revenue', label: 'Revenue', num: true, fmt: r => money(r.revenue) }, { key: 'gp', label: 'Gross profit', num: true, fmt: r => money(r.gross_profit) }], top)),
        h('div', { class: 'card' }, h('h2', {}, 'Top sellers by units'), table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'units', label: 'Units', num: true, fmt: r => num(r.units) }, { key: 'revenue', label: 'Revenue', num: true, fmt: r => money(r.revenue) }], topU))),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Slow movers'), table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'units', label: 'Units sold', num: true, fmt: r => num(r.units) }, { key: 'on_hand', label: 'On hand', num: true, fmt: r => qty(r.on_hand) }, { key: 'days_since_sale', label: 'Days since last sale', num: true }], slow)),
        h('div', { class: 'card' }, h('h2', {}, 'Profit by scent family'), c4)),
      h('div', { class: 'card' }, h('h2', {}, 'Low stock — suggested order quantity & order-by date'), table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'status', label: 'Status', fmt: r => badge(r.status) },
        { key: 'on_hand', label: 'On hand', num: true, fmt: r => qty(r.on_hand, r.uom) }, { key: 'rop', label: 'ROP', num: true, fmt: r => qty(r.rop) }, { key: 'suggested_qty', label: 'Suggested', num: true, fmt: r => qty(r.suggested_qty, r.uom) },
        { key: 'order_by', label: 'Order by', fmt: r => fmtDate(r.order_by) }, { key: 's', label: 'Source', fmt: r => r.supplier_name || 'Make' }], low, { empty: 'No low-stock items.' })),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Inventory by location (units)'), table([{ key: 'g', label: 'Type' }, ...['WKS', 'WHS', 'STR', 'QAH'].map(c => ({ key: c, label: c, num: true, fmt: r => num(r[c]) }))],
          ['raw', 'finished', 'kit', 'resale'].map(t => ({ g: t, ...Object.fromEntries(['WKS', 'WHS', 'STR', 'QAH'].map(c => [c, grid.filter(x => x.item_type === t).reduce((s, x) => s + Number(x[c.toLowerCase()]), 0)])) })))),
        h('div', { class: 'card' }, h('h2', {}, 'Supplier performance: actual vs quoted lead time'), table([{ key: 'name', label: 'Supplier' }, { key: 'q', label: 'Quoted', num: true, fmt: r => r.quoted_lead_days + ' d' },
          { key: 'a', label: 'Actual avg', num: true, fmt: r => num(r.avg_actual_lead, 1) + ' d' }, { key: 'l', label: 'Avg days late', num: true, fmt: r => num(r.avg_days_late, 1) }, { key: 'o', label: 'On-time', num: true, fmt: r => pct(r.on_time_pct) },
          { key: 'f', label: 'Fill', num: true, fmt: r => pct(r.fill_rate_pct) }, { key: 'rating', label: '', fmt: r => badge(r.rating) }], score))),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Returns by reason code'), c5),
        h('div', { class: 'card' }, h('h2', {}, 'Quality-failure returns by product'), table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'qty', label: 'Units', num: true },
          { key: 'rate', label: 'Return rate', num: true, fmt: r => { const it = itemsales.find(i => i.sku === r.sku); return it && it.units ? pct(r.qty / it.units * 100, 2) : '—'; } },
          { key: 'reasons', label: 'Reasons', fmt: r => Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ') }], qualByItem, { empty: 'No quality returns in this period.' }))),
      h('div', { class: 'card' }, h('h2', {}, 'All returns by reason & product'), table([{ key: 'reason_code', label: 'Reason' }, { key: 'is_quality', label: '', fmt: r => r.is_quality ? badge('BELOW_ROP', 'quality') : '' },
        { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'disposition', label: 'Disposition' }, { key: 'qty', label: 'Units', num: true }, { key: 'refund', label: 'Refunded', num: true, fmt: r => money(r.refund) }], ret, { scroll: true })));

    chart(c1, { type: 'bar', data: { labels: buckets.map(b => grain.value === 'month' ? b.slice(0, 7) : fmtDate(b).replace(/, \d{4}/, '')),
      datasets: chans.map((c, i) => ({ label: c.replace('_', ' '), stack: 's', backgroundColor: palette[i], data: buckets.map(b => series.filter(r => r.bucket === b && r.channel === c).reduce((s, r) => s + Number(r.net_sales), 0)) })) },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => '$' + num(v) } } } } });
    const pie = (cv, entries, lab = x => x) => chart(cv, { type: 'doughnut', data: { labels: entries.map(e => lab(e[0])), datasets: [{ data: entries.map(e => e[1]), backgroundColor: palette }] }, options: { plugins: { legend: { position: 'right' } } } });
    pie(c2, sumBy('location_code'), locName); pie(c3, sumBy('channel'), x => x.replace('_', ' '));
    chart(c4, { type: 'bar', data: { labels: byFamily.map(f => f[0]), datasets: [{ label: 'Revenue', data: byFamily.map(f => f[1].rev), backgroundColor: palette[2] }, { label: 'Gross profit', data: byFamily.map(f => f[1].gp), backgroundColor: palette[0] }] }, options: { plugins: { legend: { position: 'bottom' } } } });
    chart(c5, { type: 'bar', data: { labels: byReason.map(r => r[0]), datasets: [{ label: 'Units returned', data: byReason.map(r => r[1]), backgroundColor: byReason.map(r => qual.some(x => x.reason_code === r[0]) ? palette[5] : palette[1]) }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
    void locs; void sold;
  }
  await load();
  return onChange(['sales', 'returns'], () => load().catch(() => {}), 3000);
}
