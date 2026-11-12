import { sb, q, rpc, getItems, getSettings, getLocations, findItem } from '../lib/db.js';
import { h, money, qty, toast, modal, run, select, empty, locName, showError } from '../lib/ui.js';
import { scanField } from '../lib/scanner.js';
import { productImg } from '../lib/images.js';
import { onChange } from '../lib/realtime.js';
import { showReceipt } from '../lib/docs.js';

const ORDER = ['candle_8oz', 'mini_tin', 'soap', 'gift_set', 'accessory'];
const byCat = (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name);
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

export default async function pos(root, ctx) {
  const [items, settings, locs, customers] = await Promise.all([
    getItems(), getSettings(), getLocations(), q(sb.from('customers').select('id, name, customer_type').eq('customer_type', 'retail').order('name'))]);
  const sellable = items.filter(i => i.active && i.item_type !== 'raw').sort(byCat);
  let loc = ctx.profile.default_location && ctx.profile.default_location !== 'QAH' ? ctx.profile.default_location : 'STR';
  let onHand = {};        // item_id -> qty at selected location
  let allLoc = {};        // item_id -> {loc: qty}
  const cart = [];        // {item, qty, dtype, dval}
  let odType = 'PCT', odVal = 0, payment = 'CARD', customerId = '';

  const locSel = select(locs.filter(l => l.sellable).map(l => [l.code, l.name]), loc, { onchange: async e => { loc = e.target.value; await loadStock(); renderAll(); } });
  const search = h('input', { type: 'search', placeholder: 'Search candles, soaps, gift sets…', oninput: () => renderGrid() });
  const scanner = scanField({ autofocus: true, continuous: true, onScan: async code => {
    const it = await findItem(code);
    if (!it || it.item_type === 'raw') { toast(`No sellable item for “${code}”`, 'err'); return false; }
    addToCart(it); return true;
  } });
  const grid = h('div', { class: 'prod-grid' });
  const cartBox = h('div');
  root.append(h('div', { class: 'pos' },
    h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'fields' }, h('div', { class: 'field' }, h('label', {}, 'Selling location'), locSel),
          h('div', { class: 'field', style: { gridColumn: 'span 2' } }, h('label', {}, 'Scan (USB scanner, phone camera) or type a barcode / SKU + Enter'), scanner)),
        search),
      grid),
    h('div', { class: 'card cart' }, cartBox)));

  async function loadStock() {
    const rows = await q(sb.from('inventory_balances').select('item_id, location_code, qty'));
    onHand = {}; allLoc = {};
    for (const r of rows) {
      (allLoc[r.item_id] ||= {})[r.location_code] = Number(r.qty);
      if (r.location_code === loc) onHand[r.item_id] = Number(r.qty);
    }
  }
  function renderGrid() {
    const s = search.value.trim().toLowerCase();
    const list = sellable.filter(i => !s || (i.name + ' ' + i.sku + ' ' + (i.scent_notes || '')).toLowerCase().includes(s));
    grid.replaceChildren(...(list.length ? list.map(i => {
      const oh = onHand[i.id] || 0;
      return h('button', { class: 'prod' + (oh <= 0 ? ' out' : ''), type: 'button', onclick: () => addToCart(i), title: i.scent_notes || '' },
        productImg(i), h('b', {}, i.name), h('div', { class: 'meta' }, h('span', {}, money(i.price)), h('span', {}, oh > 0 ? `${qty(oh)} here` : 'Out here')));
    }) : [empty('No products match “' + s + '”.')]));
  }
  function addToCart(item) {
    const line = cart.find(l => l.item.id === item.id);
    if (line) line.qty += 1; else cart.push({ item, qty: 1, dtype: 'PCT', dval: 0 });
    renderCart();
  }
  function calc() {
    const lines = cart.map(l => {
      const gross = round2(l.qty * Number(l.item.price));
      const d = l.dtype === 'PCT' ? round2(gross * Math.min(Math.max(l.dval, 0), 100) / 100) : Math.min(Math.max(l.dval, 0), gross);
      return { ...l, gross, ldisc: d, after: gross - d };
    });
    const sub = lines.reduce((s, l) => s + l.gross, 0), ldt = lines.reduce((s, l) => s + l.ldisc, 0), after = sub - ldt;
    const od = odType === 'PCT' ? round2(after * Math.min(Math.max(odVal, 0), 100) / 100) : Math.min(Math.max(odVal, 0), after);
    let left = od, tax = 0;
    lines.forEach((l, i) => {
      const a = i === lines.length - 1 ? left : Math.min(round2(after ? od * l.after / after : 0), left);
      left = round2(left - a); l.net = round2(l.after - a); tax += round2(l.net * settings.sales_tax_rate);
    });
    const net = round2(after - od);
    return { lines, sub, ldt, od, net, tax: round2(tax), total: round2(net + tax) };
  }
  function checkLocations(item) {
    const per = allLoc[item.id] || {};
    const need = cart.find(l => l.item.id === item.id)?.qty || 1;
    const body = h('div', {},
      h('p', {}, `${item.name}: need ${need} at ${locName(loc)}, have ${qty(per[loc] || 0)}.`),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('tbody', {}, locs.filter(l => l.code !== loc).map(l => {
        const have = per[l.code] || 0;
        const amt = Math.min(have, Math.max(need - (per[loc] || 0), 1));
        return h('tr', {}, h('td', {}, l.name), h('td', { class: 'num' }, qty(have)),
          h('td', {}, l.sellable && have > 0 ? h('button', { class: 'sm', onclick: async e => {
            await run(e.target, async () => {
              await rpc('transfer_inventory', { p_item_id: item.id, p_from: l.code, p_to: loc, p_qty: amt, p_note: 'Pulled for POS sale' });
              toast(`Transferred ${amt} from ${l.name}`); await loadStock(); renderAll(); m.close();
            });
          } }, `Transfer ${qty(amt)} here`) : h('span', { class: 'muted' }, l.sellable ? 'none' : 'not sellable')));
      })))),
      h('p', { class: 'hint' }, 'Or create a pickup / ship order for the customer from Sales Orders.'));
    const m = modal({ title: 'Check other locations', body, actions: [{ label: 'Close' }] });
  }
  function renderCart() {
    const t = calc();
    const short = t.lines.filter(l => l.qty > (onHand[l.item.id] || 0));
    const custSel = select([['', 'Walk-in customer'], ...customers.map(c => [c.id, c.name])], customerId, { onchange: e => { customerId = e.target.value; } });
    const odT = select([['PCT', '%'], ['AMT', '$']], odType, { style: { width: '70px' }, onchange: e => { odType = e.target.value; renderCart(); } });
    const odV = h('input', { type: 'number', min: 0, step: '0.01', value: odVal || '', placeholder: '0', style: { width: '90px' }, onchange: e => { odVal = Number(e.target.value) || 0; renderCart(); } });
    const tender = h('input', { type: 'number', min: 0, step: '0.01', placeholder: 'Cash tendered' });
    const change = h('div', { class: 'muted' });
    tender.addEventListener('input', () => { const c = Number(tender.value) - t.total; change.textContent = c >= 0 ? 'Change due: ' + money(c) : ''; });
    const payBtns = h('div', { class: 'row' }, ['CARD', 'CASH'].map(p => h('button', { class: payment === p ? 'tan' : '', onclick: () => { payment = p; renderCart(); } }, p === 'CARD' ? '💳 Card' : '💵 Cash')));
    const done = h('button', { class: 'primary block lg', disabled: !cart.length || short.length > 0, onclick: e => run(e.currentTarget, complete) },
      `Complete sale · ${money(t.total)}`);
    cartBox.replaceChildren(
      h('div', { class: 'card-h' }, h('h2', {}, 'Cart'), h('div', { class: 'spacer' }), cart.length ? h('button', { class: 'sm ghost', onclick: () => { cart.length = 0; odVal = 0; renderCart(); } }, 'Clear') : null),
      cart.length ? null : empty('Scan or tap a product to start a sale.', '🛒'),
      ...t.lines.map((l, idx) => {
        const oh = onHand[l.item.id] || 0;
        return h('div', { class: 'cart-line' },
          h('div', {}, h('b', {}, l.item.name), h('div', { class: 'muted' }, `${money(l.item.price)} · ${qty(oh)} on hand here`),
            l.qty > oh ? h('div', { class: 'err-text' }, `Only ${qty(oh)} at ${loc}. `, h('a', { href: 'javascript:void 0', onclick: () => checkLocations(l.item) }, 'Check other locations')) : null),
          h('div', { style: { textAlign: 'right' } }, h('b', {}, money(l.net)), l.ldisc ? h('div', { class: 'muted' }, '−' + money(l.ldisc)) : null),
          h('div', { class: 'ctl' },
            h('button', { class: 'qtybtn sm', 'aria-label': 'Less', onclick: () => { cart[idx].qty = Math.max(1, l.qty - 1); renderCart(); } }, '−'),
            h('input', { type: 'number', min: 1, value: l.qty, 'aria-label': 'Quantity', onchange: e => { cart[idx].qty = Math.max(1, parseInt(e.target.value) || 1); renderCart(); } }),
            h('button', { class: 'qtybtn sm', 'aria-label': 'More', onclick: () => { cart[idx].qty = l.qty + 1; renderCart(); } }, '+'),
            select([['PCT', '% off'], ['AMT', '$ off']], l.dtype, { style: { width: '80px', padding: '4px' }, onchange: e => { cart[idx].dtype = e.target.value; renderCart(); } }),
            h('input', { type: 'number', min: 0, step: '0.01', value: l.dval || '', placeholder: '0', 'aria-label': 'Line discount', style: { width: '64px' }, onchange: e => { cart[idx].dval = Number(e.target.value) || 0; renderCart(); } })),
          h('div', { style: { textAlign: 'right' } }, h('button', { class: 'sm ghost', onclick: () => { cart.splice(idx, 1); renderCart(); } }, 'Remove')));
      }),
      cart.length ? h('div', { class: 'stack', style: { marginTop: '12px' } },
        h('div', { class: 'row' }, h('label', { style: { margin: 0 } }, 'Order discount'), odT, odV),
        h('div', { class: 'totals' },
          h('div', {}, h('span', {}, 'Subtotal'), h('span', {}, money(t.sub))),
          t.ldt ? h('div', {}, h('span', {}, 'Line discounts'), h('span', {}, '−' + money(t.ldt))) : null,
          t.od ? h('div', {}, h('span', {}, 'Order discount'), h('span', {}, '−' + money(t.od))) : null,
          h('div', {}, h('span', {}, `Sales tax (${(settings.sales_tax_rate * 100).toFixed(2)}%)`), h('span', {}, money(t.tax))),
          h('div', { class: 'grand' }, h('span', {}, 'Total'), h('span', {}, money(t.total)))),
        custSel, payBtns, payment === 'CASH' ? h('div', {}, tender, change) : null,
        short.length ? h('div', { class: 'callout bad' }, 'Not enough stock at this location for: ' + short.map(s => s.item.name).join(', ')) : null,
        done) : null);
  }
  async function complete() {
    const payload = cart.map(l => ({ item_id: l.item.id, qty: l.qty, disc_type: l.dtype, disc_value: l.dval }));
    const res = await rpc('post_sale', { p_location: loc, p_lines: payload, p_order_discount: odVal, p_order_discount_type: odType,
      p_payment_method: payment, p_customer_id: customerId ? Number(customerId) : null });
    toast(`Sale ${res.receipt_no} complete · ${money(res.total)}`);
    cart.length = 0; odVal = 0; customerId = '';
    await loadStock(); renderAll();
    await showReceipt(res.sale_id);
    scanner.focus();
  }
  function renderAll() { renderGrid(); renderCart(); }

  await loadStock(); renderAll();
  return onChange(['inventory_balances'], async () => { try { await loadStock(); renderAll(); } catch (e) { showError(e); } });
}
