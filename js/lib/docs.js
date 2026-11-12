// Printable documents: receipts, purchase orders.
import { sb, q, getSettings } from './db.js';
import { h, money, qty, fmtDT, fmtDate, locName, modal, printNode } from './ui.js';

const SALE_COLS = 'id, receipt_no, sale_at, location_code, channel, customer_id, sales_order_id, cashier_id, subtotal, line_discounts, order_discount, tax_rate, tax, total, payment_method, note';
const LINE_COLS = 'id, line_no, item_id, qty, unit_price, line_discount, order_disc_alloc, net_amount, tax_amount, qty_returned';

export async function loadSale(idOrNo) {
  const qb = sb.from('sales').select(SALE_COLS);
  const sale = await q(typeof idOrNo === 'number' ? qb.eq('id', idOrNo).maybeSingle() : qb.ilike('receipt_no', String(idOrNo).trim()).maybeSingle());
  if (!sale) return null;
  const lines = await q(sb.from('sale_lines').select(LINE_COLS + ', items(sku, name, barcode, category)').eq('sale_id', sale.id).order('line_no'));
  const [cust, cashier, rets] = await Promise.all([
    sale.customer_id ? q(sb.from('customers').select('name').eq('id', sale.customer_id).maybeSingle()) : null,
    sale.cashier_id ? q(sb.from('profiles').select('full_name').eq('id', sale.cashier_id).maybeSingle()) : null,
    q(sb.from('returns').select('return_no, return_at, refund_total, is_exchange').eq('sale_id', sale.id)),
  ]);
  return { ...sale, lines, customer: cust?.name, cashier: cashier?.full_name, returns: rets || [] };
}

export async function receiptNode(sale) {
  const s = await getSettings();
  const r = (a, b, cls = '') => h('div', { class: 'r ' + cls }, h('span', {}, a), h('span', {}, b));
  return h('div', { class: 'receipt' },
    h('div', { class: 'c' }, h('img', { src: 'assets/logo-mark.svg', width: 48, height: 48, alt: '' }),
      h('div', { style: { fontWeight: 700, fontSize: '15px' } }, s.company_name), h('div', {}, s.tagline),
      h('div', {}, locName(sale.location_code)), h('div', {}, s.address), h('div', {}, s.phone)),
    h('hr'),
    r('Receipt #', sale.receipt_no), r('Date', fmtDT(sale.sale_at)), r('Cashier', sale.cashier || '—'),
    sale.customer ? r('Customer', sale.customer) : null, sale.note ? h('div', {}, sale.note) : null,
    h('hr'),
    sale.lines.map(l => h('div', {},
      h('div', {}, l.items.name),
      r(`  ${qty(l.qty)} × ${money(l.unit_price)}`, money(l.qty * l.unit_price)),
      Number(l.line_discount) ? r('  line discount', '-' + money(l.line_discount)) : null)),
    h('hr'),
    r('Subtotal', money(sale.subtotal)),
    Number(sale.line_discounts) ? r('Line discounts', '-' + money(sale.line_discounts)) : null,
    Number(sale.order_discount) ? r('Order discount', '-' + money(sale.order_discount)) : null,
    r(`Sales tax (${(sale.tax_rate * 100).toFixed(2)}%)`, money(sale.tax)),
    h('div', { class: 'r', style: { fontWeight: 700, fontSize: '14px' } }, h('span', {}, 'TOTAL'), h('span', {}, money(sale.total))),
    r('Paid by', sale.payment_method.replace('_', ' ')),
    h('hr'),
    h('div', { class: 'c' }, h('svg', { class: 'rbc' })),
    h('div', { class: 'c', style: { fontSize: '11px' } }, s.return_policy),
    h('div', { class: 'c', style: { marginTop: '6px' } }, 'Thanks for keeping it cozy! 🌲'));
}

export async function showReceipt(saleOrId) {
  const sale = typeof saleOrId === 'object' ? saleOrId : await loadSale(saleOrId);
  if (!sale) throw new Error('Receipt not found.');
  const node = await receiptNode(sale);
  const drawBc = n => { const svg = n.querySelector('.rbc'); if (window.JsBarcode && svg) window.JsBarcode(svg, sale.receipt_no, { format: 'CODE128', height: 36, width: 1.4, fontSize: 11, margin: 0 }); };
  drawBc(node);
  modal({ title: 'Receipt ' + sale.receipt_no, body: node, actions: [
    { label: 'Close' },
    { label: '🖨 Print receipt', class: 'primary', onClick: async () => { const n = await receiptNode(sale); drawBc(n); printNode(n); return false; } }] });
}

export async function poNode(poId) {
  const po = await q(sb.from('purchase_orders').select('*, suppliers(*), po_lines(*, items(sku, name, uom))').eq('id', poId).single());
  const s = await getSettings();
  const total = po.po_lines.reduce((t, l) => t + l.qty_ordered * l.unit_cost, 0);
  return h('div', { class: 'doc' },
    h('div', { class: 'row' }, h('img', { src: 'assets/logo-mark.svg', width: 54, height: 54 }),
      h('div', {}, h('h1', { style: { margin: 0 } }, 'Purchase Order'), h('div', {}, s.company_name + ' · ' + s.address)),
      h('div', { class: 'sp' }), h('div', { style: { textAlign: 'right' } }, h('h2', { style: { margin: 0 } }, po.po_no), h('div', {}, 'Status: ' + po.status.replace('_', ' ')))),
    h('hr'),
    h('div', { class: 'grid g2' },
      h('div', {}, h('b', {}, 'Supplier'), h('div', {}, po.suppliers.name), h('div', {}, po.suppliers.contact_name), h('div', {}, po.suppliers.address), h('div', {}, po.suppliers.email + ' · ' + po.suppliers.phone)),
      h('div', {}, h('b', {}, 'Ship to'), h('div', {}, locName(po.ship_to)), h('div', {}, 'Order date: ' + fmtDate(po.order_date)),
        h('div', {}, `Expected: ${fmtDate(po.expected_date)} (quoted lead time ${po.suppliers.quoted_lead_days} days)`), h('div', {}, 'Terms: ' + po.suppliers.payment_terms))),
    h('table', { style: { marginTop: '18px' } },
      h('thead', {}, h('tr', {}, ['#', 'SKU', 'Description', 'Qty', 'UoM', 'Unit cost', 'Line total'].map(t => h('th', {}, t)))),
      h('tbody', {}, po.po_lines.sort((a, b) => a.line_no - b.line_no).map(l => h('tr', {},
        h('td', {}, l.line_no), h('td', {}, l.items.sku), h('td', {}, l.items.name), h('td', { class: 'num' }, qty(l.qty_ordered)),
        h('td', {}, l.items.uom), h('td', { class: 'num' }, money(l.unit_cost)), h('td', { class: 'num' }, money(l.qty_ordered * l.unit_cost))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 6 }, 'Total'), h('td', { class: 'num' }, money(total))))),
    po.notes ? h('p', {}, 'Notes: ' + po.notes) : null,
    h('p', { class: 'muted', style: { marginTop: '24px' } }, 'Please reference the PO number on your packing slip and invoice. Partial shipments must be noted on the packing slip.'));
}
export async function showPO(poId) {
  const n = await poNode(poId);
  modal({ title: 'Purchase order (sent view)', wide: true, body: n, actions: [{ label: 'Close' }, { label: '🖨 Print PO', class: 'primary', onClick: async () => { printNode(await poNode(poId)); return false; } }] });
}
