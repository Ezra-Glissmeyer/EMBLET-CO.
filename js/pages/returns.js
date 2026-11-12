import { sb, q, rpc, getItems, getReasons, findItem } from '../lib/db.js';
import { h, money, qty, fmtDT, badge, table, toast, run, select, field, empty, loading, tabs, modal, daysBetween, isoDate } from '../lib/ui.js';
import { scanField } from '../lib/scanner.js';
import { loadSale, showReceipt } from '../lib/docs.js';
import { onChange } from '../lib/realtime.js';

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

export default async function returnsPage(root) {
  const [items, reasons] = await Promise.all([getItems(), getReasons('RETURN')]);
  let view = 'new';
  const body = h('div');
  root.append(h('h1', {}, 'Returns & exchanges'),
    h('p', { class: 'muted' }, 'Scan the barcode on the receipt (or type the receipt / invoice number). Refunds reverse revenue into Sales Returns & Allowances, reverse tax, and put cost back into inventory at the original cost — or write it off if scrapped.'),
    tabs([['new', 'Process a return'], ['qa', 'QA Hold inspection'], ['hist', 'Recent returns']], view, k => { view = k; render(); }), body);

  function render() { ({ new: renderNew, qa: renderQA, hist: renderHist })[view]().catch(e => body.replaceChildren(h('div', { class: 'callout bad' }, e.message))); }

  async function renderNew() {
    const found = h('div');
    const searchIn = h('input', { type: 'search', placeholder: 'or search by customer name…' });
    const results = h('div');
    searchIn.addEventListener('change', async () => {
      const s = searchIn.value.trim(); if (!s) return results.replaceChildren();
      const custs = await q(sb.from('customers').select('id, name').ilike('name', `%${s}%`));
      if (!custs.length) return results.replaceChildren(empty('No customer matches.'));
      const sales = await q(sb.from('sales').select('id, receipt_no, sale_at, total, customer_id').in('customer_id', custs.map(c => c.id)).order('sale_at', { ascending: false }).limit(20));
      results.replaceChildren(table([{ key: 'receipt_no', label: 'Receipt' }, { key: 'sale_at', label: 'Date', fmt: r => fmtDT(r.sale_at) },
        { key: 'c', label: 'Customer', fmt: r => custs.find(c => c.id === r.customer_id)?.name }, { key: 'total', label: 'Total', num: true, fmt: r => money(r.total) }],
        sales, { onRow: r => open(r.id), empty: 'No receipts for that customer.' }));
    });
    const scan = scanField({ placeholder: 'Scan receipt barcode or type e.g. R-07012 / INV-00123', autofocus: true, onScan: async code => {
      const s = await loadSale(code.toUpperCase());
      if (!s) { toast('No receipt ' + code, 'err'); return false; }
      results.replaceChildren(); show(s); return true;
    } });
    const open = async id => { show(await loadSale(id)); results.replaceChildren(); };
    body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'fields' }, field('Receipt / invoice #', scan), field('Find by customer', searchIn)), results), found);

    function show(sale) {
      const age = daysBetween(sale.sale_at.slice(0, 10), isoDate());
      const state = sale.lines.map(l => ({ l, qty: 0, reason: 'CHANGED_MIND', disp: 'RESTOCK' }));
      const newLines = [];
      let mode = 'return';
      const refund = select([['CARD', 'Refund to card'], ['CASH', 'Cash refund'], ...(sale.payment_method === 'ACCOUNT' ? [['ACCOUNT', 'Credit wholesale account (A/R)']] : [])], sale.payment_method === 'CASH' ? 'CASH' : sale.payment_method === 'ACCOUNT' ? 'ACCOUNT' : 'CARD');
      const diffPay = select([['CARD', 'Card'], ['CASH', 'Cash']], 'CARD');
      const sumBox = h('div', { class: 'totals' });
      const newBox = h('div');
      const linesBox = h('div');
      const recalc = () => {
        let merch = 0, tax = 0;
        for (const s of state) if (s.qty > 0) { merch += round2(s.l.net_amount * s.qty / s.l.qty); tax += round2(s.l.tax_amount * s.qty / s.l.qty); }
        const credit = round2(merch + tax);
        const newTotal = round2(newLines.reduce((t, n) => t + round2(n.item.price * n.qty * (1 + Number(sale.tax_rate))), 0));
        sumBox.replaceChildren(
          h('div', {}, h('span', {}, 'Merchandise refund'), h('span', {}, money(merch))),
          h('div', {}, h('span', {}, 'Tax refund'), h('span', {}, money(tax))),
          h('div', { class: 'grand' }, h('span', {}, mode === 'return' ? 'Refund total' : 'Exchange credit'), h('span', {}, money(credit))),
          mode === 'exchange' ? h('div', {}, h('span', {}, 'New items (incl. tax)'), h('span', {}, money(newTotal))) : null,
          mode === 'exchange' ? h('div', { class: 'grand' }, h('span', {}, newTotal - credit >= 0 ? 'Customer pays' : 'Refund to customer'), h('span', {}, money(Math.abs(newTotal - credit)))) : null);
      };
      const drawLines = () => linesBox.replaceChildren(table([
        { key: 'item', label: 'Item', fmt: s => `${s.l.items.sku} · ${s.l.items.name}` },
        { key: 'sold', label: 'Sold', num: true, fmt: s => qty(s.l.qty) },
        { key: 'ret', label: 'Already returned', num: true, fmt: s => qty(s.l.qty_returned) },
        { key: 'paid', label: 'Paid (net)', num: true, fmt: s => money(s.l.net_amount) },
        { key: 'q', label: 'Return qty', fmt: s => s.l.qty - s.l.qty_returned > 0 ? h('input', { type: 'number', class: 'inline-in', min: 0, max: s.l.qty - s.l.qty_returned, value: s.qty, oninput: e => { s.qty = Math.min(Number(e.target.value) || 0, s.l.qty - s.l.qty_returned); recalc(); } }) : h('span', { class: 'muted' }, 'fully returned') },
        { key: 'r', label: 'Reason', fmt: s => select(reasons.map(r => [r.code, r.description + (r.is_quality ? ' (quality)' : '')]), s.reason, { onchange: e => {
          s.reason = e.target.value; const qual = reasons.find(r => r.code === s.reason)?.is_quality;
          s.disp = qual ? (['CRACKED_JAR', 'DAMAGED_IN_TRANSIT'].includes(s.reason) ? 'SCRAP' : 'QA_HOLD') : 'RESTOCK'; drawLines(); recalc(); } }) },
        { key: 'd', label: 'Disposition', fmt: s => select([['RESTOCK', 'Restock (sellable)'], ['QA_HOLD', 'QA Hold'], ['SCRAP', 'Scrap / write off']], s.disp, { onchange: e => { s.disp = e.target.value; } }) },
      ], state));
      const drawNew = () => newBox.replaceChildren(
        h('h3', {}, 'Replacement items'),
        scanField({ placeholder: 'Scan or type the replacement item', onScan: async code => {
          const it = await findItem(code); if (!it || it.item_type === 'raw') { toast('Not a sellable item', 'err'); return false; }
          const ex = newLines.find(n => n.item.id === it.id); if (ex) ex.qty++; else newLines.push({ item: it, qty: 1 }); drawNew(); recalc(); return true; } }),
        select([['', '…or pick an item'], ...items.filter(i => i.item_type !== 'raw' && i.active).map(i => [i.id, `${i.name} (${money(i.price)})`])], '', { style: { marginTop: '6px' }, onchange: e => {
          const it = items.find(i => i.id == e.target.value); if (it) { newLines.push({ item: it, qty: 1 }); drawNew(); recalc(); } } }),
        ...newLines.map((n, i) => h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'sp' }, n.item.name),
          h('input', { type: 'number', class: 'inline-in', min: 1, value: n.qty, onchange: e => { n.qty = Math.max(1, Number(e.target.value) || 1); recalc(); } }),
          h('span', {}, money(n.item.price)), h('button', { class: 'sm ghost', onclick: () => { newLines.splice(i, 1); drawNew(); recalc(); } }, '✕'))),
        field('Difference paid / refunded by', diffPay));
      const modeTabs = tabs([['return', 'Return for refund'], ['exchange', 'Exchange']], mode, k => { mode = k; newBox.hidden = k !== 'exchange'; refundField.hidden = k === 'exchange'; recalc(); });
      const refundField = field('Refund method', refund);
      const go = h('button', { class: 'primary lg', onclick: e => run(e.currentTarget, async () => {
        const ret = state.filter(s => s.qty > 0).map(s => ({ sale_line_id: s.l.id, qty: s.qty, reason_code: s.reason, disposition: s.disp }));
        if (!ret.length) throw new Error('Enter a return quantity on at least one line.');
        if (mode === 'return') {
          const r = await rpc('process_return', { p_sale_id: sale.id, p_lines: ret, p_refund_method: refund.value });
          toast(`Return ${r.return_no} processed · refunded ${money(r.refund_total)}`);
        } else {
          if (!newLines.length) throw new Error('Add the replacement item(s).');
          const r = await rpc('process_exchange', { p_sale_id: sale.id, p_return_lines: ret, p_new_lines: newLines.map(n => ({ item_id: n.item.id, qty: n.qty })), p_payment_method: diffPay.value });
          toast(`Exchange done (${r.return_no} → ${r.receipt_no}). ${r.price_difference >= 0 ? 'Customer paid' : 'Refunded'} ${money(Math.abs(r.price_difference))}`);
          showReceipt(r.new_sale_id);
        }
        show(await loadSale(sale.id));
      }) }, 'Process');
      newBox.hidden = true;
      drawLines(); drawNew(); recalc();
      found.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', {}, sale.receipt_no), h('span', { class: 'muted' }, `${fmtDT(sale.sale_at)} · ${sale.location_code} · ${sale.customer || 'walk-in'} · paid ${sale.payment_method} · total ${money(sale.total)}`),
          h('span', { class: 'spacer' }), h('button', { class: 'sm', onclick: () => showReceipt(sale) }, 'View receipt')),
        age > 30 ? h('div', { class: 'callout warn' }, `This receipt is ${age} days old — outside the 30-day return policy. Manager approval recommended.`) : null,
        sale.returns.length ? h('div', { class: 'callout', style: { margin: '8px 0' } }, 'Previous returns: ' + sale.returns.map(r => `${r.return_no} (${money(r.refund_total)})`).join(', ')) : null,
        modeTabs, linesBox, h('div', { class: 'grid g2', style: { marginTop: '12px' } }, h('div', {}, refundField, newBox), h('div', { class: 'stack' }, sumBox, go))));
    }
  }

  async function renderQA() {
    body.replaceChildren(loading());
    const rows = await q(sb.from('inventory_balances').select('item_id, qty, items(sku, name, uom, avg_cost)').eq('location_code', 'QAH').gt('qty', 0));
    body.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Goods in QA Hold'),
      h('p', { class: 'muted' }, 'QA Hold is a non-sellable location. Inspect each item: if it passes, transfer it back to a sellable location; if it fails, scrap it (posts to Scrap / Write-off expense).'),
      table([
        { key: 'sku', label: 'SKU', fmt: r => r.items.sku }, { key: 'name', label: 'Item', fmt: r => r.items.name },
        { key: 'qty', label: 'Qty held', num: true, fmt: r => qty(r.qty) }, { key: 'v', label: 'Value', num: true, fmt: r => money(r.qty * r.items.avg_cost) },
        { key: 'act', label: '', fmt: r => h('div', { class: 'row' },
          h('button', { class: 'sm', onclick: e => run(e.target, async () => { await rpc('transfer_inventory', { p_item_id: r.item_id, p_from: 'QAH', p_to: 'STR', p_qty: 1, p_note: 'Passed QA inspection' }); toast('1 passed → Storefront'); renderQA(); }) }, '✔ Pass 1 → Storefront'),
          h('button', { class: 'sm danger', onclick: e => run(e.target, async () => { await rpc('adjust_inventory', { p_item_id: r.item_id, p_location: 'QAH', p_qty_change: -1, p_reason_code: 'QA_SCRAP', p_note: 'Failed QA inspection' }); toast('1 scrapped'); renderQA(); }) }, '✕ Scrap 1')) },
      ], rows, { empty: 'Nothing in QA Hold.', emptyIcon: '✅' })));
  }

  async function renderHist() {
    body.replaceChildren(loading());
    const rows = await q(sb.from('returns').select('id, return_no, return_at, refund_method, refund_total, is_exchange, sale_id, sales(receipt_no), return_lines(qty, reason_code, disposition, items(sku))').order('id', { ascending: false }).limit(100));
    body.replaceChildren(table([
      { key: 'return_no', label: 'Return', fmt: r => h('b', {}, r.return_no) }, { key: 'return_at', label: 'When', fmt: r => fmtDT(r.return_at) },
      { key: 'rec', label: 'Original receipt', fmt: r => h('a', { href: 'javascript:void 0', onclick: () => showReceipt(r.sale_id) }, r.sales?.receipt_no) },
      { key: 'type', label: 'Type', fmt: r => r.is_exchange ? badge('x', 'Exchange') : badge('x', 'Return') },
      { key: 'lines', label: 'Items · reason · disposition', fmt: r => r.return_lines.map(l => `${qty(l.qty)}× ${l.items.sku} · ${l.reason_code} · ${l.disposition}`).join('; ') },
      { key: 'refund_total', label: 'Refund', num: true, fmt: r => money(r.refund_total) }, { key: 'refund_method', label: 'Method' },
    ], rows, { scroll: true }));
  }

  render();
  return onChange(['returns', 'inventory_balances'], () => { if (view !== 'new') render(); }, 600);
}
