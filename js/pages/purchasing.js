import { sb, q, rpc, getItems, getLocations, findItem } from '../lib/db.js';
import { h, money, qty, fmtDate, badge, table, tabs, modal, field, select, toast, run, isoDate, loading, locName, daysBetween, empty } from '../lib/ui.js';
import { scanField } from '../lib/scanner.js';
import { showPO } from '../lib/docs.js';
import { onChange } from '../lib/realtime.js';

export default async function purchasing(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  const [items, locs, suppliers, supItems] = await Promise.all([getItems(), getLocations(), q(sb.from('suppliers').select('*').eq('active', true).order('name')), q(sb.from('supplier_items').select('*'))]);
  let view = ctx.params.get('tab') || 'pos';
  const body = h('div');
  root.append(h('div', { class: 'row' }, h('h1', {}, 'Purchasing'), h('div', { class: 'sp' }), isMgr ? h('button', { class: 'primary', onclick: () => newPO() }, '+ New purchase order') : null),
    h('p', { class: 'muted' }, 'Create PO → Order Sent (expected date = order date + supplier quoted lead time) → Received (full or partial) → Closed. Receipts raise inventory, update weighted-average cost and create an A/P invoice due per the supplier\'s terms.'),
    tabs([['pos', 'Purchase orders'], ['receive', 'Scan to receive'], ...(isMgr ? [['ap', 'A/P invoices & payments']] : [])], view, k => { view = k; render(); }), body);
  const render = () => ({ pos: listPOs, receive: () => receive(), ap: listAP })[view]().catch(e => body.replaceChildren(h('div', { class: 'callout bad' }, e.message)));

  let poStatus = 'open', poSup = '';
  async function listPOs() {
    body.replaceChildren(loading());
    let qb = sb.from('purchase_orders').select('*, suppliers(name), po_lines(qty_ordered, qty_received, unit_cost), po_receipts(received_date, days_late)').order('id', { ascending: false }).limit(300);
    if (poStatus === 'open') qb = qb.in('status', ['ORDER_SENT', 'PARTIALLY_RECEIVED']);
    else if (poStatus) qb = qb.eq('status', poStatus);
    if (poSup) qb = qb.eq('supplier_id', Number(poSup));
    const rows = await q(qb);
    const today = isoDate();
    const bar = h('div', { class: 'row', style: { marginBottom: '10px' } },
      select([['open', 'Open (Order Sent / Partially Received)'], ['', 'All statuses'], ['ORDER_SENT', 'Order Sent'], ['PARTIALLY_RECEIVED', 'Partially Received'], ['RECEIVED', 'Received'], ['CLOSED', 'Closed'], ['CANCELLED', 'Cancelled']],
             poStatus, { onchange: e => { poStatus = e.target.value; listPOs(); } }),
      select([['', 'All suppliers'], ...suppliers.map(x => [x.id, x.name])], poSup, { onchange: e => { poSup = e.target.value; listPOs(); } }),
      h('span', { class: 'muted' }, `${rows.length} PO(s) · ${rows.filter(r => ['ORDER_SENT', 'PARTIALLY_RECEIVED'].includes(r.status) && r.expected_date < today).length} past expected date`));
    body.replaceChildren(bar, table([
      { key: 'po_no', label: 'PO', fmt: r => h('b', {}, r.po_no) }, { key: 'sup', label: 'Supplier', fmt: r => r.suppliers.name },
      { key: 'order_date', label: 'Ordered', fmt: r => fmtDate(r.order_date) },
      { key: 'expected_date', label: 'Expected', fmt: r => h('span', { style: { color: ['ORDER_SENT', 'PARTIALLY_RECEIVED'].includes(r.status) && r.expected_date < today ? 'var(--red)' : '' } }, fmtDate(r.expected_date)) },
      { key: 'rcv', label: 'Received', fmt: r => r.po_receipts.length ? fmtDate(r.po_receipts.map(x => x.received_date).sort()[0]) : '—' },
      { key: 'late', label: 'Early / late', fmt: r => { if (!r.po_receipts.length) return ''; const d = Math.min(...r.po_receipts.map(x => x.days_late)); return h('span', { class: 'badge ' + (d > 0 ? 'red' : 'green') }, d > 0 ? `${d} d late` : d < 0 ? `${-d} d early` : 'on time'); } },
      { key: 'fill', label: 'Fill', num: true, fmt: r => { const o = r.po_lines.reduce((s, l) => s + Number(l.qty_ordered), 0), g = r.po_lines.reduce((s, l) => s + Number(l.qty_received), 0); return r.po_receipts.length ? Math.round(g / o * 100) + '%' : ''; } },
      { key: 'v', label: 'Value', num: true, fmt: r => money(r.po_lines.reduce((s, l) => s + l.qty_ordered * l.unit_cost, 0)) },
      { key: 'status', label: 'Status', fmt: r => badge(r.status) },
    ], rows, { onRow: r => openPO(r.id), scroll: true, empty: poStatus === 'open' ? 'No open purchase orders.' : 'No purchase orders match.' }));
  }

  async function openPO(id) {
    const po = await q(sb.from('purchase_orders').select('*, suppliers(*), po_lines(*, items(sku, name, uom)), po_receipts(*, receipt_lines(*))').eq('id', id).single());
    const open = ['ORDER_SENT', 'PARTIALLY_RECEIVED'].includes(po.status);
    const actions = [{ label: 'Close' }, { label: '📄 View / print sent PO', onClick: async () => { await showPO(po.id); return true; } }];
    if (open && isMgr) actions.push({ label: po.po_receipts.length ? 'Close PO (short-shipped)' : 'Cancel PO', class: 'danger', onClick: async () => { await rpc('close_purchase_order', { p_po_id: po.id }); toast(po.po_no + ' closed'); render(); return true; } });
    if (po.status === 'RECEIVED' && isMgr) actions.push({ label: 'Close PO', onClick: async () => { await rpc('close_purchase_order', { p_po_id: po.id }); toast(po.po_no + ' closed'); render(); return true; } });
    if (open) actions.push({ label: '📥 Receive…', class: 'primary', onClick: async () => { view = 'receive'; await receive(po.id); return true; } });
    modal({ title: `${po.po_no} · ${po.suppliers.name}`, wide: true, body: h('div', {},
      h('div', { class: 'row' }, badge(po.status), h('span', {}, `Ship to ${locName(po.ship_to)} · ordered ${fmtDate(po.order_date)} · expected ${fmtDate(po.expected_date)} (quoted ${po.suppliers.quoted_lead_days} d) · ${po.suppliers.payment_terms}`)),
      table([{ key: 'i', label: 'Item', fmt: l => `${l.items.sku} · ${l.items.name}` }, { key: 'qo', label: 'Ordered', num: true, fmt: l => qty(l.qty_ordered, l.items.uom) },
        { key: 'qr', label: 'Received', num: true, fmt: l => qty(l.qty_received, l.items.uom) }, { key: 'uc', label: 'Unit cost', num: true, fmt: l => money(l.unit_cost) },
        { key: 't', label: 'Total', num: true, fmt: l => money(l.qty_ordered * l.unit_cost) }], po.po_lines.sort((a, b) => a.line_no - b.line_no)),
      po.po_receipts.length ? h('div', { style: { marginTop: '10px' } }, h('h3', {}, 'Receipts'), ...po.po_receipts.map(r => h('div', {}, `${r.receipt_no} · ${fmtDate(r.received_date)} at ${r.location_code} · `,
        h('span', { class: 'badge ' + (r.days_late > 0 ? 'red' : 'green') }, r.days_late > 0 ? `${r.days_late} days late` : r.days_late < 0 ? `${-r.days_late} days early` : 'on time')))) : null),
      actions });
  }

  async function receive(poId) {
    const open = await q(sb.from('purchase_orders').select('id, po_no, ship_to, expected_date, suppliers(name)').in('status', ['ORDER_SENT', 'PARTIALLY_RECEIVED']).order('expected_date'));
    const poSel = select([['', 'Choose an open PO…'], ...open.map(p => [p.id, `${p.po_no} · ${p.suppliers.name} · expected ${fmtDate(p.expected_date)}`])], poId || '');
    const locSel = select(locs.filter(l => l.code !== 'QAH').map(l => [l.code, l.name]), 'WKS');
    const date = h('input', { type: 'date', value: isoDate(), max: isoDate() });
    const linesBox = h('div');
    let lines = [], inputs = {};
    async function loadPO() {
      if (!poSel.value) { lines = []; linesBox.replaceChildren(empty('Choose a PO, then scan each item as you unpack it — every scan adds 1 (or type quantities).', '📥')); return; }
      const po = await q(sb.from('purchase_orders').select('*, po_lines(*, items(sku, name, uom, barcode))').eq('id', poSel.value).single());
      locSel.value = po.ship_to;
      lines = po.po_lines.sort((a, b) => a.line_no - b.line_no); inputs = {};
      linesBox.replaceChildren(table([
        { key: 'i', label: 'Item', fmt: l => `${l.items.sku} · ${l.items.name}` }, { key: 'b', label: 'Barcode', fmt: l => h('code', {}, l.items.barcode) },
        { key: 'o', label: 'Ordered', num: true, fmt: l => qty(l.qty_ordered, l.items.uom) }, { key: 'r', label: 'Already received', num: true, fmt: l => qty(l.qty_received) },
        { key: 'n', label: 'Receiving now', fmt: l => { const i = h('input', { type: 'number', class: 'inline-in', min: 0, step: 'any', value: 0 }); inputs[l.id] = i; return i; } },
        { key: 'f', label: '', fmt: l => h('button', { class: 'sm', onclick: () => { inputs[l.id].value = Math.max(0, l.qty_ordered - l.qty_received); } }, 'All remaining') },
      ], lines));
    }
    poSel.addEventListener('change', loadPO);
    const scan = scanField({ continuous: true, placeholder: 'Scan item barcode — each scan adds 1', onScan: async code => {
      const it = await findItem(code);
      const l = it && lines.find(x => x.item_id === it.id);
      if (!l) { toast(it ? `${it.name} is not on this PO` : 'Unknown barcode ' + code, 'err'); return false; }
      inputs[l.id].value = Number(inputs[l.id].value || 0) + 1; inputs[l.id].closest('tr').classList.add('flash'); setTimeout(() => inputs[l.id].closest('tr')?.classList.remove('flash'), 1600);
      return true;
    } });
    const post = h('button', { class: 'primary lg', onclick: e => run(e.target, async () => {
      if (!poSel.value) throw new Error('Choose a PO.');
      const ls = Object.entries(inputs).map(([id, i]) => ({ po_line_id: Number(id), qty: Number(i.value) || 0 })).filter(x => x.qty > 0);
      if (!ls.length) throw new Error('Enter or scan at least one received quantity.');
      const r = await rpc('receive_purchase_order', { p_po_id: Number(poSel.value), p_location: locSel.value, p_lines: ls, p_received_date: date.value });
      toast(`${r.receipt_no} posted — ${r.days_late > 0 ? r.days_late + ' days LATE' : r.days_late < 0 ? -r.days_late + ' days early' : 'on time'}. PO is ${r.po_status.replace('_', ' ').toLowerCase()}; invoice ${r.invoice_no} created.`, 'ok', 7000);
      await receive(r.po_status === 'PARTIALLY_RECEIVED' ? Number(poSel.value) : undefined); }) }, 'Post receipt');   // stay on a part-received PO
    body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'fields' }, field('Purchase order', poSel), field('Receive into', locSel), field('Receipt date', date)),
      field('Scan to receive', scan), linesBox, h('div', { class: 'row end', style: { marginTop: '12px' } }, post)));
    await loadPO();
  }

  async function listAP() {
    body.replaceChildren(loading());
    const rows = await q(sb.from('ap_invoices').select('*, suppliers(name, payment_terms)').order('due_date', { ascending: true }).limit(400));
    const today = isoDate();
    const openRows = rows.filter(r => r.status === 'OPEN'), paid = rows.filter(r => r.status === 'PAID').reverse().slice(0, 60);
    const cols = [
      { key: 'invoice_no', label: 'Invoice', fmt: r => h('b', {}, r.invoice_no) }, { key: 's', label: 'Supplier', fmt: r => r.suppliers.name },
      { key: 't', label: 'Terms', fmt: r => r.suppliers.payment_terms }, { key: 'invoice_date', label: 'Invoice date', fmt: r => fmtDate(r.invoice_date) },
      { key: 'due_date', label: 'Due', fmt: r => h('span', { style: { color: r.status === 'OPEN' && r.due_date < today ? 'var(--red)' : '' } }, fmtDate(r.due_date)) },
      { key: 'flag', label: '', fmt: r => r.status === 'PAID' ? badge('PAID') : r.due_date < today ? badge('BELOW_ROP', `Past due ${daysBetween(r.due_date, today)} d`) : r.discount_date && r.discount_date >= today ? badge('OK', `2% off until ${fmtDate(r.discount_date)}`) : badge('OPEN', `Due in ${daysBetween(today, r.due_date)} d`) },
      { key: 'amount', label: 'Amount', num: true, fmt: r => money(r.amount) }, { key: 'bal', label: 'Balance', num: true, fmt: r => money(r.amount - r.amount_paid) },
      { key: 'p', label: '', fmt: r => r.status === 'OPEN' ? h('button', { class: 'sm primary', onclick: () => payAP(r) }, 'Pay…') : '' },
    ];
    const owed = openRows.reduce((s, r) => s + (r.amount - r.amount_paid), 0), past = openRows.filter(r => r.due_date < today).reduce((s, r) => s + (r.amount - r.amount_paid), 0);
    body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Open invoices'), h('span', { class: 'spacer' }), h('b', {}, `Owed ${money(owed)}`), h('span', { class: past ? 'badge red' : 'badge green' }, `Past due ${money(past)}`)),
      table(cols, openRows, { empty: 'All supplier invoices are paid.' })),
      h('div', { class: 'card' }, h('h2', {}, 'Recently paid'), table(cols, paid)));
  }

  // Record a supplier payment (full or partial; 2/10 Net 30 invoices can take 2% off if paid in full by the discount date)
  function payAP(inv) {
    const today = isoDate();
    const open = Math.round((inv.amount - inv.amount_paid) * 100) / 100;
    const canDisc = inv.discount_pct > 0 && inv.amount_paid === 0 && inv.discount_date && today <= inv.discount_date;
    const disc = canDisc ? Math.round(inv.amount * inv.discount_pct) / 100 : 0;
    const take = h('input', { type: 'checkbox', checked: canDisc, disabled: !canDisc });
    const amt = h('input', { type: 'number', step: '0.01', min: 0.01, value: canDisc ? (open - disc).toFixed(2) : open.toFixed(2) });
    const date = h('input', { type: 'date', value: today, max: today });
    const note = h('div', { class: 'hint' });
    const sync = () => {
      amt.disabled = take.checked;
      if (take.checked) amt.value = (open - disc).toFixed(2);
      note.textContent = take.checked ? `Paying ${money(open - disc)} settles the full ${money(open)}: ${money(disc)} is booked to 7000 Purchase Discounts Earned.` : 'Less than the balance = a partial payment; the invoice stays open.';
    };
    take.addEventListener('change', sync); sync();
    modal({ title: `Pay ${inv.invoice_no} · ${inv.suppliers.name}`, body: h('div', {},
      h('p', {}, `Terms ${inv.suppliers.payment_terms} · invoiced ${fmtDate(inv.invoice_date)} · due ${fmtDate(inv.due_date)} · open balance `, h('b', {}, money(open))),
      canDisc ? h('div', { class: 'callout' }, `2/10 Net 30: pay in full by ${fmtDate(inv.discount_date)} and save ${money(disc)}.`)
        : inv.discount_pct > 0 ? h('div', { class: 'callout warn' }, `The 2% early-payment window closed on ${fmtDate(inv.discount_date)}.`) : null,
      h('div', { class: 'fields' }, field('Amount', amt), field('Payment date', date)), h('label', { class: 'row' }, take, 'Take the early-payment discount'), note),
      actions: [{ label: 'Cancel' }, { label: 'Record payment', class: 'primary', onClick: async () => {
        const a = Number(amt.value);
        if (!take.checked && !(a > 0)) throw new Error('Enter an amount greater than $0.');
        if (!take.checked && a > open + 0.001) throw new Error(`That's more than the open balance (${money(open)}).`);
        if (date.value > today) throw new Error('Payment date cannot be in the future.');
        const res = await rpc('record_supplier_payment', { p_invoice_id: inv.id, p_amount: take.checked ? null : a, p_paid_date: date.value, p_take_discount: take.checked });
        toast(res.status === 'PAID' ? `${inv.invoice_no} paid in full${take.checked ? ` (saved ${money(disc)})` : ''}` : `${money(a)} paid · ${money(res.amount - res.amount_paid)} still open`);
        listAP(); return true;
      } }] });
  }

  function newPO(prefill) {
    const sup = select(suppliers.map(s => [s.id, `${s.name} (${s.quoted_lead_days} d, ${s.payment_terms})`]), prefill?.supplier_id || suppliers[0].id);
    const ship = select(locs.filter(l => l.code !== 'QAH' && l.code !== 'STR').map(l => [l.code, l.name]), 'WKS');
    const notes = h('input', { placeholder: 'Optional' });
    const box = h('div'); const exp = h('div', { class: 'hint' });
    const lines = prefill?.lines || [];
    const purch = () => items.filter(i => ['raw', 'resale'].includes(i.item_type) && i.active && (supItems.some(si => si.supplier_id == sup.value && si.item_id === i.id) || i.preferred_supplier_id == sup.value));
    const cost = id => supItems.find(si => si.supplier_id == sup.value && si.item_id == id)?.unit_cost ?? items.find(i => i.id == id)?.avg_cost;
    const draw = () => {
      const s = suppliers.find(x => x.id == sup.value);
      exp.textContent = `Expected receipt: ${fmtDate(new Date(Date.now() + s.quoted_lead_days * 864e5))} (today + ${s.quoted_lead_days}-day quoted lead time)`;
      box.replaceChildren(...lines.map((l, i) => h('div', { class: 'row', style: { marginBottom: '6px' } },
        select([['', 'Item…'], ...purch().map(it => [it.id, `${it.sku} · ${it.name} (${it.uom})`])], l.item_id, { style: { flex: 1 }, onchange: e => { l.item_id = Number(e.target.value); l.unit_cost = cost(l.item_id); draw(); } }),
        h('input', { type: 'number', class: 'inline-in', min: 0, step: 'any', value: l.qty, title: 'Qty', onchange: e => { l.qty = Number(e.target.value); draw(); } }),
        h('input', { type: 'number', class: 'inline-in', min: 0, step: '0.0001', value: l.unit_cost ?? '', title: 'Unit cost', onchange: e => { l.unit_cost = Number(e.target.value); draw(); } }),
        h('span', { style: { width: '80px', textAlign: 'right' } }, money((l.qty || 0) * (l.unit_cost || 0))),
        h('button', { class: 'sm ghost', onclick: () => { lines.splice(i, 1); draw(); } }, '✕'))),
        h('button', { class: 'sm', onclick: () => { lines.push({ item_id: '', qty: 1 }); draw(); } }, '+ Add line'),
        h('div', { style: { textAlign: 'right', fontWeight: 700 } }, 'Total ' + money(lines.reduce((t, l) => t + (l.qty || 0) * (l.unit_cost || 0), 0))));
    };
    sup.addEventListener('change', () => { lines.length = 0; lines.push({ item_id: '', qty: 1 }); draw(); });
    if (!lines.length) lines.push({ item_id: '', qty: 1 });
    draw();
    modal({ title: 'New purchase order', wide: true, body: h('div', {}, h('div', { class: 'fields' }, field('Supplier', sup), field('Ship to', ship)), exp, field('Notes', notes), h('label', {}, 'Lines (qty · unit cost)'), box),
      actions: [{ label: 'Cancel' }, { label: 'Create & send PO', class: 'primary', onClick: async () => {
        const ls = lines.filter(l => l.item_id && l.qty > 0).map(l => ({ item_id: l.item_id, qty: l.qty, unit_cost: l.unit_cost }));
        if (!ls.length) throw new Error('Add at least one line.');
        const r = await rpc('create_purchase_order', { p_supplier_id: Number(sup.value), p_ship_to: ship.value, p_lines: ls, p_notes: notes.value || null });
        toast(`${r.po_no} sent — expected ${fmtDate(r.expected_date)}`); view = 'pos'; render(); showPO(r.po_id); return true; } }] });
  }

  render();
  return onChange(['purchase_orders', 'ap_invoices'], () => { if (view !== 'receive') render(); }, 600);
}
