import { sb, q, getItems, invalidateItems } from '../lib/db.js';
import { h, money, qty, table, tabs, modal, field, select, toast, typeLabel, badge, confirmBox } from '../lib/ui.js';
import { productImg } from '../lib/images.js';

export default async function itemsPage(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  let [items, bom, suppliers] = await Promise.all([getItems(true), q(sb.from('bom_lines').select('*')), q(sb.from('suppliers').select('id, name, quoted_lead_days').order('name'))]);
  let view = 'finished';
  const body = h('div');
  root.append(h('h1', {}, 'Items & bills of material'),
    h('p', { class: 'muted' }, 'Gift sets are kits made from other finished goods (a 2-level BOM), so MRP explodes them recursively: gift set → candles / soaps → raw materials. Standard cost is the BOM rolled up at component standard cost.'),
    tabs([['finished', 'Finished goods'], ['kit', 'Gift sets'], ['raw', 'Raw materials'], ['resale', 'Resale']], view, k => { view = k; draw(); }), body);
  const byId = id => items.find(i => i.id === id);
  const supName = id => suppliers.find(s => s.id === id)?.name;

  function draw() {
    const rows = items.filter(i => i.item_type === view);
    body.replaceChildren(table([
      { key: 'img', label: '', fmt: r => { const d = productImg(r); d.style.width = '44px'; d.style.height = '44px'; d.style.borderRadius = '8px'; d.style.overflow = 'hidden'; return d; } },
      { key: 'sku', label: 'SKU', fmt: r => h('b', {}, r.sku) }, { key: 'name', label: 'Name' },
      { key: 'barcode', label: 'Barcode', fmt: r => h('code', {}, r.barcode) }, { key: 'uom', label: 'UoM' },
      { key: 'std_cost', label: 'Std cost', num: true, fmt: r => money(r.std_cost) }, { key: 'avg_cost', label: 'Avg cost', num: true, fmt: r => money(r.avg_cost) },
      ...(view !== 'raw' ? [{ key: 'price', label: 'Price', num: true, fmt: r => money(r.price) },
        { key: 'm', label: 'Margin', num: true, fmt: r => r.price ? ((1 - r.avg_cost / r.price) * 100).toFixed(0) + '%' : '—' }] : []),
      { key: 'lead_time_days', label: 'Lead (d)', num: true }, { key: 'ordering_policy', label: 'Policy', fmt: r => badge('x', r.ordering_policy === 'MRP' ? 'MRP' : 'ROP / EOQ') },
      { key: 'sup', label: 'Supplier', fmt: r => supName(r.preferred_supplier_id) || (['finished', 'kit'].includes(r.item_type) ? 'Made in-house' : '—') },
      { key: 'active', label: '', fmt: r => r.active ? '' : badge('CANCELLED', 'Inactive') },
    ], rows, { onRow: r => openItem(r) }));
  }

  function bomTree(item, depth = 0, mult = 1) {
    const lines = bom.filter(b => b.parent_id === item.id);
    return lines.flatMap(b => {
      const c = byId(b.component_id);
      return [{ depth, c, qty: b.qty_per * mult, per: b.qty_per, line: b }, ...bomTree(c, depth + 1, b.qty_per * mult)];
    });
  }

  function openItem(it) {
    const tree = bomTree(it);
    const used = bom.filter(b => b.component_id === it.id).map(b => byId(b.parent_id));
    const price = h('input', { type: 'number', step: '0.01', value: it.price ?? '' });
    const rop = h('input', { type: 'number', step: 'any', value: it.reorder_point_override ?? '', placeholder: 'calculated' });
    const lead = h('input', { type: 'number', min: 0, value: it.lead_time_days });
    const pol = select([['ROP_EOQ', 'ROP / EOQ (independent demand)'], ['MRP', 'MRP (dependent demand)']], it.ordering_policy);
    const sup = select([['', '— none —'], ...suppliers.map(s => [s.id, s.name])], it.preferred_supplier_id || '');
    const active = h('input', { type: 'checkbox', checked: it.active });
    const bomBox = h('div');
    const drawBom = () => {
      const top = bom.filter(b => b.parent_id === it.id);
      const rolled = top.reduce((s, b) => s + b.qty_per * byId(b.component_id).std_cost, 0);
      bomBox.replaceChildren(top.length ? h('div', {},
        h('h3', {}, 'Bill of materials (exploded)'),
        table([
          { key: 'c', label: 'Component', fmt: r => h('span', { style: { paddingLeft: r.depth * 18 + 'px' } }, (r.depth ? '↳ ' : '') + `${r.c.sku} · ${r.c.name}`) },
          { key: 'per', label: 'Qty per parent', num: true, fmt: r => qty(r.per, r.c.uom) },
          { key: 'qty', label: 'Qty per 1 ' + it.sku, num: true, fmt: r => qty(r.qty, r.c.uom) },
          { key: 'cost', label: 'Std cost', num: true, fmt: r => r.depth === 0 ? money(r.per * r.c.std_cost) : h('span', { class: 'muted' }, money(r.qty * r.c.std_cost)) },
          { key: 'x', label: '', fmt: r => isMgr && r.depth === 0 ? h('button', { class: 'sm ghost', onclick: async () => {
            if (!await confirmBox('Remove component?', `Remove ${r.c.sku} from the BOM?`, 'Remove', true)) return;
            await q(sb.from('bom_lines').delete().eq('id', r.line.id)); bom = bom.filter(b => b.id !== r.line.id); drawBom(); } }, '✕') : '' },
        ], tree), h('p', { class: 'hint' }, `Rolled-up standard cost: ${money(rolled)} (indented rows are already included in their parent's cost).`)) : null,
        isMgr && ['finished', 'kit'].includes(it.item_type) ? addBomRow() : null);
    };
    const addBomRow = () => {
      const c = select([['', 'Add component…'], ...items.filter(x => x.id !== it.id).map(x => [x.id, `${x.sku} · ${x.name}`])], '');
      const n = h('input', { type: 'number', step: 'any', class: 'inline-in', placeholder: 'qty' });
      return h('div', { class: 'row', style: { marginTop: '8px' } }, c, n, h('button', { class: 'sm', onclick: async () => {
        if (!c.value || !(Number(n.value) > 0)) return toast('Choose a component and quantity', 'err');
        const [row] = await q(sb.from('bom_lines').insert({ parent_id: it.id, component_id: Number(c.value), qty_per: Number(n.value) }).select());
        bom.push(row); drawBom(); } }, 'Add'));
    };
    drawBom();
    const img = productImg(it); img.style.width = '160px'; img.style.borderRadius = '12px'; img.style.overflow = 'hidden';
    modal({ title: `${it.sku} · ${it.name}`, wide: true, body: h('div', {},
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, img, h('div', { class: 'sp' },
        h('div', {}, badge('x', typeLabel(it.item_type)), ' ', it.scent_family ? badge('x', it.scent_family) : null),
        it.scent_notes ? h('p', { style: { margin: '6px 0' } }, h('b', {}, it.scent_notes)) : null, h('p', { class: 'muted' }, it.description || ''),
        h('div', { class: 'muted' }, `Barcode ${it.barcode} · UoM ${it.uom} · standard ${money(it.std_cost)} · weighted average ${money(it.avg_cost)}`),
        used.length ? h('div', { class: 'muted' }, 'Used in: ' + used.map(u => u.name).join(', ')) : null)),
      isMgr ? h('div', { class: 'fields', style: { marginTop: '12px' } },
        it.item_type !== 'raw' ? field('Selling price', price) : null, field('Reorder point override', rop, 'Leave blank to use the calculated ROP'),
        field(['finished', 'kit'].includes(it.item_type) ? 'Production lead time (days)' : 'Lead time (days)', lead), field('Ordering policy', pol),
        ['raw', 'resale'].includes(it.item_type) ? field('Preferred supplier', sup) : null, field('Active', active)) : null,
      bomBox),
      actions: isMgr ? [{ label: 'Close' }, { label: 'Save changes', class: 'primary', onClick: async () => {
        const patch = { reorder_point_override: rop.value === '' ? null : Number(rop.value), lead_time_days: Number(lead.value), ordering_policy: pol.value, active: active.checked };
        if (it.item_type !== 'raw') patch.price = price.value === '' ? null : Number(price.value);
        if (['raw', 'resale'].includes(it.item_type)) patch.preferred_supplier_id = sup.value ? Number(sup.value) : null;
        await q(sb.from('items').update(patch).eq('id', it.id));
        invalidateItems(); items = await getItems(true); draw(); toast('Saved ' + it.sku); return true; } }] : [{ label: 'Close' }] });
  }
  draw();
}
