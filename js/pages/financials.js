import { sb, q, rpc } from '../lib/db.js';
import { h, money, pct, num, qty, table, tabs, field, run, loading, chart, palette, isoDate, addDays, select, kpi, downloadCSV, fmtDate } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function financials(root) {
  let view = 'pnl';
  const today = isoDate();
  const presets = [['ytd', 'Year to date'], ['12m', 'Last 12 months'], ['qtr', 'Last 90 days'], ['mtd', 'Month to date'], ['lyq4', 'Last holiday quarter (Oct–Dec)']];
  const range = k => {
    const d = new Date(today + 'T12:00:00'), y = d.getFullYear();
    return { ytd: [`${y}-01-01`, today], '12m': [addDays(today, -364), today], qtr: [addDays(today, -89), today], mtd: [today.slice(0, 8) + '01', today], lyq4: [`${y - 1}-10-01`, `${y - 1}-12-31`] }[k];
  };
  const from = h('input', { type: 'date', value: range('12m')[0] }), to = h('input', { type: 'date', value: today });
  const pre = select(presets, '12m', { onchange: e => { [from.value, to.value] = range(e.target.value); render(); } });
  const body = h('div');
  root.append(h('h1', {}, 'Financial reporting'),
    h('p', { class: 'muted' }, 'Built live from the general ledger (gl_entries) and the inventory ledger. Every sale, return, receipt, adjustment and production completion posts here automatically.'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, field('Period', pre), field('From', from), field('To', to), h('button', { class: 'primary', onclick: e => run(e.target, render) }, 'Refresh'))),
    tabs([['pnl', 'Profit & loss'], ['val', 'Inventory valuation'], ['turn', 'Inventory turnover'], ['gl', 'General ledger']], view, k => { view = k; render(); }), body);

  async function render() {
    body.replaceChildren(loading());
    if (view === 'pnl') return pnl();
    if (view === 'val') return valuation();
    if (view === 'turn') return turnover();
    return gl();
  }

  async function pnl() {
    const p = await rpc('fn_pnl', { p_from: from.value, p_to: to.value });
    const L = (label, v, o = {}) => h('tr', { style: o.bold ? { fontWeight: 700, background: 'var(--paper)' } : {} },
      h('td', { style: { paddingLeft: o.indent ? '28px' : '10px' } }, label), h('td', { class: 'num' }, o.neg ? `(${money(v)})` : money(v)), h('td', { class: 'num muted' }, p.net_sales ? pct(v / p.net_sales * 100) : ''));
    const cv = h('canvas', { height: 110 });
    body.replaceChildren(
      h('div', { class: 'kpis' }, kpi('Net sales', money(p.net_sales, true), `${fmtDate(p.from)} – ${fmtDate(p.to)}`), kpi('Gross profit', money(p.gross_profit, true), `margin ${pct(p.gross_margin_pct)}`, 'good'),
        kpi('Operating expenses', money(p.operating_expenses, true)), kpi('Net income', money(p.net_income, true), '', p.net_income >= 0 ? 'good' : 'bad'),
        kpi('Trial balance', p.trial_balance_check == 0 ? 'Balanced ✔' : money(p.trial_balance_check), 'total debits − credits', p.trial_balance_check == 0 ? 'good' : 'bad')),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Profit & Loss'), h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, '% of net'))),
          h('tbody', {},
            L('Gross sales revenue', p.gross_sales), L('Less: sales discounts', p.discounts, { indent: 1, neg: 1 }), L('Less: sales returns & allowances', p.returns, { indent: 1, neg: 1 }),
            L('Net sales', p.net_sales, { bold: 1 }), L('Cost of goods sold (weighted avg)', p.cogs, { indent: 1, neg: 1 }),
            L('Gross profit', p.gross_profit, { bold: 1 }),
            L('Scrap / inventory write-offs', p.writeoffs, { indent: 1, neg: 1 }), L('Inventory adjustments (net)', p.inventory_adjustments, { indent: 1, neg: 1 }),
            ...p.opex_detail.map(o => L(o.name, o.amount, { indent: 1, neg: 1 })),
            L('Operating income', p.operating_income, { bold: 1 }), L('Other income: purchase discounts', p.other_income, { indent: 1 }),
            L('Net income', p.net_income, { bold: 1 }))))),
        h('div', { class: 'card' }, h('h2', {}, 'By month'), cv)));
    chart(cv, { data: { labels: p.by_month.map(m => m.month), datasets: [
      { type: 'bar', label: 'Net sales', data: p.by_month.map(m => m.net_sales), backgroundColor: palette[2] },
      { type: 'bar', label: 'COGS', data: p.by_month.map(m => m.cogs), backgroundColor: palette[1] },
      { type: 'line', label: 'Gross profit', data: p.by_month.map(m => m.net_sales - m.cogs), borderColor: palette[0], tension: .3 }] },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: v => '$' + num(v / 1000) + 'k' } } } } });
  }

  async function valuation() {
    const [sum, rows] = await Promise.all([rpc('fn_inventory_summary'), q(sb.from('v_inventory_valuation').select('*').order('inv_group').order('sku'))]);
    const by = {};
    for (const r of rows) { const k = r.item_id; by[k] ||= { sku: r.sku, name: r.name, grp: r.inv_group, cost: r.avg_cost, WKS: 0, WHS: 0, STR: 0, QAH: 0, qty: 0, value: 0 }; by[k][r.location_code] += Number(r.qty); by[k].qty += Number(r.qty); by[k].value += Number(r.value); }
    const list = Object.values(by);
    const g = n => sum.by_group?.find(x => x.group === n)?.value || 0;
    body.replaceChildren(
      h('div', { class: 'kpis' }, kpi('Raw materials', money(g('Raw Materials')), `GL 1200: ${money(sum.gl_raw)}`), kpi('Finished goods', money(g('Finished Goods')), `GL 1210: ${money(sum.gl_finished)}`),
        kpi('Work in process', money(sum.wip_orders), `GL 1250: ${money(sum.gl_wip)}`), kpi('Total inventory', money(g('Raw Materials') + g('Finished Goods') + Number(sum.wip_orders)), 'at weighted average cost', 'good')),
      h('div', { class: 'callout', style: { marginBottom: '12px' } }, 'Sub-ledger (qty × weighted average cost) vs. general ledger: any difference is cents of rounding from averaging.'),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'By location'), h('span', { class: 'spacer' })),
        table([{ key: 'location', label: 'Location' }, { key: 'raw', label: 'Raw materials', num: true, fmt: r => money(r.raw || 0) }, { key: 'finished', label: 'Finished goods', num: true, fmt: r => money(r.finished || 0) },
          { key: 't', label: 'Total', num: true, fmt: r => h('b', {}, money((r.raw || 0) + (r.finished || 0))) }], sum.by_location || [])),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'By item'), h('span', { class: 'spacer' }), h('button', { class: 'sm', onclick: () => downloadCSV('valuation.csv', list) }, 'Export CSV')),
        table([{ key: 'grp', label: 'Group' }, { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, ...['WKS', 'WHS', 'STR', 'QAH'].map(c => ({ key: c, label: c, num: true, fmt: r => qty(r[c]) })),
          { key: 'qty', label: 'Qty', num: true, fmt: r => qty(r.qty) }, { key: 'cost', label: 'Avg cost', num: true, fmt: r => money(r.cost) }, { key: 'value', label: 'Value', num: true, fmt: r => h('b', {}, money(r.value)) }],
          list, { scroll: true, foot: { name: list.length + ' items', value: money(list.reduce((s, r) => s + r.value, 0)) } })));
  }

  async function turnover() {
    const rows = await rpc('fn_turnover', { p_from: from.value, p_to: to.value });
    body.replaceChildren(h('div', { class: 'callout', style: { marginBottom: '12px' } },
      'Turnover = cost of usage ÷ average inventory value (annualised). Finished goods use COGS (net of returns, plus candles consumed into gift sets); raw materials use cost issued to production. Average inventory = mean of the inventory value at the start, every month-end and the end of the period. Days on hand = average inventory ÷ daily cost of usage.'),
      table([{ key: 'scope', label: 'Scope', fmt: r => r.scope === 'category' ? h('span', { class: 'muted' }, 'category') : h('b', {}, r.scope) }, { key: 'label', label: '', fmt: r => r.scope === 'category' ? r.label.replace('_', ' ') : h('b', {}, r.label) },
        { key: 'cost_of_usage', label: 'COGS / usage', num: true, fmt: r => money(r.cost_of_usage) }, { key: 'begin_value', label: 'Begin value', num: true, fmt: r => money(r.begin_value) },
        { key: 'end_value', label: 'End value', num: true, fmt: r => money(r.end_value) }, { key: 'avg_inventory', label: 'Avg inventory', num: true, fmt: r => money(r.avg_inventory) },
        { key: 'turnover', label: 'Turns / yr', num: true, fmt: r => h('b', {}, num(r.turnover, 2)) }, { key: 'days_on_hand', label: 'Days on hand', num: true, fmt: r => num(r.days_on_hand, 1) }], rows));
  }

  async function gl() {
    const rows = await q(sb.from('gl_entries').select('*, gl_accounts(name)').gte('entry_date', from.value).lte('entry_date', to.value).order('id', { ascending: false }).limit(500));
    body.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Latest journal lines in period (most recent 500)'),
      table([{ key: 'entry_date', label: 'Date', fmt: r => fmtDate(r.entry_date) }, { key: 'journal_id', label: 'Journal', num: true }, { key: 'account_code', label: 'Acct' }, { key: 'n', label: 'Account', fmt: r => r.gl_accounts.name },
        { key: 'debit', label: 'Debit', num: true, fmt: r => Number(r.debit) ? money(r.debit) : '' }, { key: 'credit', label: 'Credit', num: true, fmt: r => Number(r.credit) ? money(r.credit) : '' },
        { key: 'ref_type', label: 'Type' }, { key: 'ref_no', label: 'Reference' }, { key: 'memo', label: 'Memo', fmt: r => h('span', { class: 'muted' }, r.memo) }], rows, { scroll: true })));
  }

  await render();
  return onChange(['sales', 'returns', 'inventory_balances', 'production_orders', 'ap_invoices'], () => render().catch(() => {}), 1500);
}
