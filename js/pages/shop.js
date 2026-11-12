import { sb, q, rpc, getLocations } from '../lib/db.js';
import { h, money, toast, run, select, field, isoDate, addDays, empty, locName, modal } from '../lib/ui.js';
import { productImg } from '../lib/images.js';
import { onChange } from '../lib/realtime.js';

const ORDER = ['candle_8oz', 'mini_tin', 'soap', 'gift_set', 'accessory'];
const byCat = (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name);
const CATS = [['', 'Everything'], ['candle_8oz', '8 oz Candles'], ['mini_tin', 'Mini Tins'], ['soap', 'Soap Bars'], ['gift_set', 'Gift Sets'], ['accessory', 'Accessories']];

export default async function shop(root, ctx) {
  const locs = (await getLocations()).filter(l => l.sellable && l.code !== 'WKS');
  let products = [], cat = '', fam = '';
  const cart = new Map();
  const grid = h('div', { class: 'shop-grid' });
  const cartBtn = h('button', { class: 'primary', onclick: () => checkout() });
  const catSel = select(CATS, cat, { onchange: e => { cat = e.target.value; draw(); } });
  const famSel = select([['', 'All scent families'], ['woodsy', 'Woodsy'], ['sweet', 'Sweet'], ['fresh', 'Fresh'], ['citrus', 'Citrus'], ['floral', 'Floral']], fam, { onchange: e => { fam = e.target.value; draw(); } });
  root.append(
    h('div', { class: 'shop-hero' }, h('h1', {}, 'Cozy goods, poured in Utah County'),
      h('p', {}, 'Hand-poured soy & beeswax candles and small-batch soap. Order online and pick up at our Provo storefront or the Springville warehouse — we\'ll have it wrapped and waiting.')),
    h('div', { class: 'row', style: { marginBottom: '14px' } }, catSel, famSel, h('div', { class: 'sp' }), cartBtn), grid);

  const updCart = () => { const n = [...cart.values()].reduce((s, c) => s + c.qty, 0); cartBtn.textContent = `🛍️ Pickup bag (${n})`; cartBtn.disabled = !n; };
  async function load() { products = (await q(sb.from('v_catalog').select('*'))).sort(byCat); draw(); }
  function draw() {
    const list = products.filter(p => (!cat || p.category === cat) && (!fam || p.scent_family === fam));
    grid.replaceChildren(...(list.length ? list.map(p => {
      const avail = p.availability || {}, total = Object.values(avail).reduce((a, b) => a + b, 0);
      return h('div', { class: 'shop-card' }, productImg(p),
        h('div', { class: 'body' }, h('b', { style: { fontFamily: 'var(--serif)', fontSize: '1.05rem' } }, p.name),
          p.scent_notes ? h('div', { class: 'notes' }, p.scent_notes) : null, h('div', { class: 'desc' }, p.description),
          h('div', { class: 'avail' }, total ? locs.map(l => `${avail[l.code] || 0} at ${l.name.split(' – ')[0]}`).join(' · ') : 'Out of stock — we\'re pouring more!'),
          h('div', { class: 'row' }, h('span', { class: 'price' }, money(p.price)), h('div', { class: 'sp' }),
            h('button', { class: 'tan', disabled: !total, onclick: () => { const c = cart.get(p.id) || { p, qty: 0 }; c.qty++; cart.set(p.id, c); updCart(); toast(`Added ${p.name}`); } }, 'Add'))));
    }) : [empty('Nothing in this category right now.')]));
  }
  function checkout() {
    const loc = select(locs.map(l => [l.code, l.name]), 'STR');
    const date = h('input', { type: 'date', value: addDays(isoDate(), 1), min: isoDate() });
    const notes = h('input', { placeholder: 'Gift wrap? Anything we should know?' });
    const box = h('div');
    const draw2 = () => {
      const total = [...cart.values()].reduce((s, c) => s + c.qty * c.p.price, 0);
      box.replaceChildren(...[...cart.values()].map(c => {
        const have = c.p.availability?.[loc.value] || 0;
        return h('div', { class: 'row', style: { borderBottom: '1px solid var(--line-2)', padding: '6px 0' } }, h('span', { class: 'sp' }, c.p.name, have < c.qty ? h('div', { class: 'hint', style: { color: 'var(--amber)' } }, `Only ${have} at ${locName(loc.value)} today — we'll have the rest ready by your pickup date.`) : null),
          h('input', { type: 'number', min: 0, value: c.qty, class: 'inline-in', onchange: e => { c.qty = Number(e.target.value); if (!c.qty) cart.delete(c.p.id); updCart(); draw2(); } }), h('span', { style: { width: '70px', textAlign: 'right' } }, money(c.qty * c.p.price)));
      }), h('div', { style: { textAlign: 'right', marginTop: '8px' } }, h('b', {}, 'Estimated total ' + money(total)), h('div', { class: 'hint' }, 'Plus Utah sales tax. Pay at pickup.')));
    };
    loc.addEventListener('change', draw2); draw2();
    modal({ title: 'Order for pickup', body: h('div', {}, h('div', { class: 'fields' }, field('Pickup location', loc), field('Pickup date', date)), field('Notes', notes), box),
      actions: [{ label: 'Keep shopping' }, { label: 'Place pickup order', class: 'primary', onClick: async () => {
        const lines = [...cart.values()].filter(c => c.qty > 0).map(c => ({ item_id: c.p.id, qty: c.qty }));
        if (!lines.length) throw new Error('Your bag is empty.');
        const r = await rpc('create_sales_order', { p_customer_id: null, p_location: loc.value, p_requested_date: date.value, p_lines: lines, p_notes: notes.value || 'Website pickup order' });
        cart.clear(); updCart(); toast(`Thanks! Order ${r.so_no} placed — see My Orders.`); ctx.go('myorders'); return true; } }] });
  }
  updCart(); await load();
  return onChange(['inventory_balances', 'items'], () => load().catch(() => {}), 1000);
}
