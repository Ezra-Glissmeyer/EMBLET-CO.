import { sb, q, getItems, invalidateItems } from '../lib/db.js';
import { h, money, qty, table, tabs, modal, field, select, toast, typeLabel, badge, confirmBox, run } from '../lib/ui.js';
import { productImg } from '../lib/images.js';
import { onChange } from '../lib/realtime.js';

const CATS = {
  raw: [['wax', 'Wax'], ['wick', 'Wick'], ['fragrance', 'Fragrance oil'], ['dye', 'Candle dye'], ['container', 'Jar / tin / lid'], ['label', 'Label'],
        ['soap_base', 'Soap base'], ['colorant', 'Soap colorant'], ['additive', 'Additive'], ['packaging', 'Packaging']],
  finished: [['candle_8oz', '8 oz candle'], ['mini_tin', '4 oz mini tin'], ['soap', '4 oz soap bar']],
  kit: [['gift_set', 'Gift set']],
  resale: [['accessory', 'Accessory']],
};
const UOMS = ['ea', 'lb', 'oz'];
const FAMILIES = ['', 'woodsy', 'sweet', 'fresh', 'citrus', 'floral'];
// Barcode prefixes: EMB1xxxx raw, 2 candles, 3 soaps, 4 mini tins, 5 gift sets, 6 resale
const prefixFor = (type, cat) => ({ raw: '1', kit: '5', resale: '6' }[type] || { candle_8oz: '2', soap: '3', mini_tin: '4' }[cat] || '2');
const made = it => ['finished', 'kit'].includes(it.item_type);

export default async function itemsPage(root, ctx) {
  const isMgr = ['manager', 'admin'].includes(ctx.role);
  let [items, bom, suppliers] = await Promise.all([getItems(true), q(sb.from('bom_lines').select('*')), q(sb.from('suppliers').select('id, name, quoted_lead_days').order('name'))]);
  let view = 'finished', search = '';
  const body = h('div');
  const searchIn = h('input', { type: 'search', placeholder: 'Search SKU, name or barcode', oninput: e => { search = e.target.value.toLowerCase(); draw(); } });
  root.append(
    h('div', { class: 'row' }, h('h1', {}, 'Items & bills of material'), h('div', { class: 'sp' }),
      isMgr ? h('button', { class: 'primary', onclick: () => editItem(null) }, '+ New item') : null),
    h('p', { class: 'muted' }, 'The item master. Gift sets are kits made from other finished goods (a 2-level BOM), so MRP explodes them recursively: gift set → candles / soaps → raw materials. Standard cost of a made item = its BOM rolled up at component standard cost, recalculated whenever a BOM or a component cost changes.'),
    h('div', { class: 'row', style: { marginBottom: '8px' } }, searchIn),
    tabs([['finished', 'Finished goods'], ['kit', 'Gift sets'], ['raw', 'Raw materials'], ['resale', 'Resale']], view, k => { view = k; draw(); }), body);
  const byId = id => items.find(i => i.id === id);
  const supName = id => suppliers.find(s => s.id === id)?.name;
  async function reload() { invalidateItems(); [items, bom] = await Promise.all([getItems(true), q(sb.from('bom_lines').select('*'))]); draw(); }

  function draw() {
    const rows = items.filter(i => i.item_type === view && (!search || `${i.sku} ${i.name} ${i.barcode}`.toLowerCase().includes(search)));
    body.replaceChildren(table([
      { key: 'img', label: '', fmt: r => { const d = productImg(r); Object.assign(d.style, { width: '44px', height: '44px', borderRadius: '8px', overflow: 'hidden' }); return d; } },
      { key: 'sku', label: 'SKU', fmt: r => h('b', {}, r.sku) }, { key: 'name', label: 'Name' },
      { key: 'barcode', label: 'Barcode', fmt: r => h('code', {}, r.barcode) }, { key: 'uom', label: 'UoM' },
      { key: 'std_cost', label: 'Std cost', num: true, fmt: r => money(r.std_cost) }, { key: 'avg_cost', label: 'Avg cost', num: true, fmt: r => money(r.avg_cost) },
      ...(view !== 'raw' ? [{ key: 'price', label: 'Price', num: true, fmt: r => money(r.price) },
        { key: 'm', label: 'Margin', num: true, fmt: r => r.price ? ((1 - r.avg_cost / r.price) * 100).toFixed(0) + '%' : '—' }] : []),
      ...(made({ item_type: view }) ? [{ key: 'bom', label: 'BOM lines', num: true, fmt: r => bom.filter(b => b.parent_id === r.id).length || h('span', { style: { color: 'var(--red)' } }, 'none') }] : []),
      { key: 'lead_time_days', label: 'Lead (d)', num: true }, { key: 'ordering_policy', label: 'Policy', fmt: r => badge('x', r.ordering_policy === 'MRP' ? 'MRP' : 'ROP / EOQ') },
      { key: 'sup', label: 'Supplier', fmt: r => supName(r.preferred_supplier_id) || (made(r) ? 'Made in-house' : '—') },
      { key: 'active', label: '', fmt: r => r.active ? '' : badge('CANCELLED', 'Inactive') },
    ], rows, { onRow: r => openItem(r), empty: search ? 'No items match.' : 'No items of this type yet.' }));
  }

  // ---------- BOM helpers
  const children = id => bom.filter(b => b.parent_id === id);
  function bomTree(item, depth = 0, mult = 1) {
    return children(item.id).flatMap(b => {
      const c = byId(b.component_id);
      return [{ depth, c, qty: b.qty_per * mult, per: b.qty_per, line: b }, ...bomTree(c, depth + 1, b.qty_per * mult)];
    });
  }
  const contains = (parentId, targetId) => children(parentId).some(b => b.component_id === targetId || contains(b.component_id, targetId));
  // Roll standard cost up through every BOM level and save any item whose standard changed
  async function rollupStdCosts() {
    const std = Object.fromEntries(items.map(i => [i.id, Number(i.std_cost)]));
    for (let pass = 0; pass < 5; pass++) {
      for (const p of items.filter(i => children(i.id).length)) std[p.id] = Math.round(children(p.id).reduce((s, b) => s + b.qty_per * std[b.component_id], 0) * 10000) / 10000;
    }
    const changed = items.filter(i => Math.abs(std[i.id] - Number(i.std_cost)) > 0.00005);
    for (const i of changed) {
      const rows = await q(sb.from('items').update({ std_cost: std[i.id] }).eq('id', i.id).select('id'));
      if (!rows.length) throw new Error('Not saved: only managers can change item costs.');
      i.std_cost = std[i.id];
    }
    return changed;
  }

  // ---------- view one item (+ BOM editor)
  function openItem(it) {
    const bomBox = h('div');
    const drawBom = () => {
      const tree = bomTree(it), top = children(it.id);
      const rolled = top.reduce((s, b) => s + b.qty_per * byId(b.component_id).std_cost, 0);
      const used = bom.filter(b => b.component_id === it.id).map(b => byId(b.parent_id));
      bomBox.replaceChildren(
        used.length ? h('p', { class: 'muted' }, 'Used in: ' + used.map(u => `${u.name} (${qty(bom.find(b => b.parent_id === u.id && b.component_id === it.id).qty_per, it.uom)} each)`).join(', ')) : null,
        made(it) ? h('h3', {}, 'Bill of materials (exploded)') : null,
        made(it) && !top.length ? h('div', { class: 'callout warn' }, 'No BOM yet: this item cannot be produced or planned by MRP until you add its components.') : null,
        top.length ? table([
          { key: 'c', label: 'Component', fmt: r => h('span', { style: { paddingLeft: r.depth * 18 + 'px' } }, (r.depth ? '↳ ' : '') + `${r.c.sku} · ${r.c.name}`) },
          { key: 'per', label: 'Qty per parent', num: true, fmt: r => isMgr && r.depth === 0
              ? h('span', {}, h('input', { type: 'number', step: 'any', min: 0, class: 'inline-in', value: r.per, onchange: e => run(null, async () => {
                  const v = Number(e.target.value);
                  if (!(v > 0)) { e.target.value = r.per; throw new Error('Quantity per parent must be greater than zero.'); }
                  const rows = await q(sb.from('bom_lines').update({ qty_per: v }).eq('id', r.line.id).select());
                  if (!rows.length) throw new Error('Not saved: only managers can edit BOMs.');
                  r.line.qty_per = v; const ch = await rollupStdCosts(); toast(`BOM updated · standard cost recalculated for ${ch.length} item(s)`); drawBom(); draw();
                }) }), ' ', r.c.uom)
              : qty(r.per, r.c.uom) },
          { key: 'qty', label: 'Qty per 1 ' + it.sku, num: true, fmt: r => qty(r.qty, r.c.uom) },
          { key: 'cost', label: 'Std cost', num: true, fmt: r => r.depth === 0 ? money(r.per * r.c.std_cost) : h('span', { class: 'muted' }, money(r.qty * r.c.std_cost)) },
          { key: 'x', label: '', fmt: r => isMgr && r.depth === 0 ? h('button', { class: 'sm ghost', title: 'Remove', onclick: () => run(null, async () => {
            if (!await confirmBox('Remove component?', `Remove ${r.c.sku} from the ${it.sku} BOM?`, 'Remove', true)) return;
            const rows = await q(sb.from('bom_lines').delete().eq('id', r.line.id).select());
            if (!rows.length) throw new Error('Not removed: only managers can edit BOMs.');
            bom = bom.filter(b => b.id !== r.line.id); const ch = await rollupStdCosts(); toast(`Removed ${r.c.sku} · standard cost recalculated for ${ch.length} item(s)`); drawBom(); draw();
          }) }, '✕') : '' },
        ], tree) : null,
        top.length ? h('p', { class: 'hint' }, `Rolled-up standard cost: ${money(rolled)} per ${it.uom} (indented rows are already included in their parent's line).`) : null,
        isMgr && made(it) ? addBomRow() : null);
    };
    const addBomRow = () => {
      const c = select([['', 'Add component…'], ...items.filter(x => x.id !== it.id && x.active && !children(it.id).some(b => b.component_id === x.id))
        .map(x => [x.id, `${x.sku} · ${x.name} (${x.uom})`])], '');
      const n = h('input', { type: 'number', step: 'any', min: 0, class: 'inline-in', placeholder: 'qty' });
      return h('div', { class: 'row', style: { marginTop: '8px' } }, c, n, h('button', { class: 'sm', onclick: e => run(e.currentTarget, async () => {
        const cid = Number(c.value), v = Number(n.value);
        if (!cid) throw new Error('Choose a component.');
        if (!(v > 0)) throw new Error('Enter a quantity per parent greater than zero.');
        if (contains(cid, it.id)) throw new Error(`${byId(cid).sku} already contains ${it.sku} in its own BOM. Adding it would create a loop that MRP can't explode.`);
        const rows = await q(sb.from('bom_lines').insert({ parent_id: it.id, component_id: cid, qty_per: v }).select());
        if (!rows.length) throw new Error('Not saved: only managers can edit BOMs.');
        bom.push(rows[0]); const ch = await rollupStdCosts();
        toast(`Added ${byId(cid).sku} · standard cost recalculated for ${ch.length} item(s)`); drawBom(); draw();
      }) }, 'Add component'));
    };
    drawBom();
    const img = productImg(it); Object.assign(img.style, { width: '160px', borderRadius: '12px', overflow: 'hidden', flex: 'none' });
    modal({ title: `${it.sku} · ${it.name}`, wide: true, body: h('div', {},
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, img, h('div', { class: 'sp' },
        h('div', {}, badge('x', typeLabel(it.item_type)), ' ', badge('x', it.category), ' ', it.scent_family ? badge('x', it.scent_family) : null, ' ', it.active ? null : badge('CANCELLED', 'Inactive')),
        it.scent_notes ? h('p', { style: { margin: '6px 0' } }, h('b', {}, it.scent_notes)) : null, h('p', { class: 'muted' }, it.description || ''),
        h('div', { class: 'formula' }, `Barcode ${it.barcode} · UoM ${it.uom}\nStandard cost ${money(it.std_cost)} · weighted-average cost ${money(it.avg_cost)}${it.price ? ` · price ${money(it.price)}` : ''}\nLead time ${it.lead_time_days} d · policy ${it.ordering_policy}${it.reorder_point_override != null ? ` · ROP override ${it.reorder_point_override}` : ''}${it.preferred_supplier_id ? ` · supplier ${supName(it.preferred_supplier_id)}` : ''}`),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('a', { class: 'btn sm', href: `#/inventory?tab=ledger&item=${it.id}` }, 'Item ledger →'),
          h('a', { class: 'btn sm', href: '#/labels' }, 'Print labels →')))),
      bomBox),
      actions: isMgr ? [{ label: 'Close' }, { label: '✎ Edit item', class: 'primary', onClick: () => { setTimeout(() => editItem(it), 0); return true; } }] : [{ label: 'Close' }] });
  }

  // ---------- create / edit item
  function editItem(it) {
    const isNew = !it;
    const v = it || { item_type: view, category: CATS[view][0][0], uom: view === 'raw' ? 'lb' : 'ea', ordering_policy: view === 'raw' ? 'MRP' : 'ROP_EOQ', active: true, lead_time_days: view === 'raw' ? 7 : view === 'kit' ? 1 : 2, color_hex: '#C8A27A', accent_hex: '#9CAF88' };
    const f = {};
    const inp = (k, attrs = {}) => (f[k] = h('input', { value: v[k] ?? '', ...attrs }));
    const type = (f.item_type = select([['raw', 'Raw material'], ['finished', 'Finished good'], ['kit', 'Gift set (kit)'], ['resale', 'Resale']], v.item_type, { disabled: !isNew }));
    const cat = (f.category = select(CATS[v.item_type], v.category));
    const uom = (f.uom = select(UOMS.map(u => [u, u]), v.uom));
    const fam = (f.scent_family = select(FAMILIES.map(x => [x, x || '—']), v.scent_family || ''));
    const pol = (f.ordering_policy = select([['ROP_EOQ', 'ROP / EOQ (independent demand)'], ['MRP', 'MRP (dependent demand)']], v.ordering_policy));
    const sup = (f.preferred_supplier_id = select([['', '— none —'], ...suppliers.map(s => [s.id, s.name])], v.preferred_supplier_id || ''));
    const active = (f.active = h('input', { type: 'checkbox', checked: v.active }));
    const bc = inp('barcode', { placeholder: 'auto' });
    const nextBarcode = () => {
      const pre = 'EMB' + prefixFor(type.value, cat.value);
      const nums = items.map(i => i.barcode).filter(b => b.startsWith(pre)).map(b => Number(b.slice(4)));
      return pre + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0');
    };
    if (isNew) bc.value = nextBarcode();
    const preview = h('div', { style: { width: '120px', flex: 'none' } });
    const drawPreview = () => preview.replaceChildren(productImg({ name: f.name.value || 'New item', sku: f.sku.value, category: cat.value, uom: uom.value, color_hex: f.color_hex.value, accent_hex: f.accent_hex.value }));
    const showFor = () => {
      const t = type.value;
      for (const [k, show] of Object.entries({ price: t !== 'raw', std_cost: !['finished', 'kit'].includes(t), preferred_supplier_id: ['raw', 'resale'].includes(t),
        scent_family: ['finished', 'kit'].includes(t), scent_notes: ['finished', 'kit'].includes(t), batch_size: ['finished', 'kit'].includes(t) })) {
        f[k].closest('.field').hidden = !show;
      }
      f.lead_time_days.closest('.field').querySelector('label').textContent = ['finished', 'kit'].includes(t) ? 'Production lead time (days)' : 'Supplier lead time (days)';
    };
    type.addEventListener('change', () => {
      cat.replaceChildren(...CATS[type.value].map(([a, b]) => h('option', { value: a }, b)));
      pol.value = type.value === 'raw' ? 'MRP' : 'ROP_EOQ'; uom.value = type.value === 'raw' ? 'lb' : 'ea';
      if (isNew) bc.value = nextBarcode(); showFor(); drawPreview();
    });
    cat.addEventListener('change', () => { if (isNew) bc.value = nextBarcode(); drawPreview(); });
    sup.addEventListener('change', () => { const s = suppliers.find(x => x.id == sup.value); if (s && isNew) f.lead_time_days.value = s.quoted_lead_days; });
    const body = h('div', {},
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, preview, h('div', { class: 'sp' },
        h('div', { class: 'fields' }, field('Type', type), field('Category', cat), field('UoM', uom)),
        h('div', { class: 'fields' }, field('SKU', inp('sku', { placeholder: 'e.g. CND-ALPINE', disabled: !isNew, style: { textTransform: 'uppercase' } })), field('Name', inp('name')), field('Barcode (Code 128)', bc)))),
      h('div', { class: 'fields' }, field('Selling price ($)', inp('price', { type: 'number', step: '0.01', min: 0 })),
        field('Standard / purchase cost ($)', inp('std_cost', { type: 'number', step: '0.0001', min: 0 }), 'Made items: rolled up from the BOM automatically'),
        field('Preferred supplier', sup), field('Lead time (days)', inp('lead_time_days', { type: 'number', min: 0 }))),
      h('div', { class: 'fields' }, field('Ordering policy', pol), field('Reorder point override', inp('reorder_point_override', { type: 'number', step: 'any', min: 0, placeholder: 'calculated' }), 'Blank = calculated ROP'),
        field('Production batch size', inp('batch_size', { type: 'number', min: 1 })), field('Active', active)),
      h('div', { class: 'fields' }, field('Scent family', fam), field('Scent notes', inp('scent_notes')),
        field('Main colour', inp('color_hex', { type: 'color', style: { height: '38px', padding: '2px' } })), field('Accent colour', inp('accent_hex', { type: 'color', style: { height: '38px', padding: '2px' } }))),
      field('Description', (f.description = h('textarea', { rows: 2 }, v.description || ''))));
    for (const k of ['name', 'sku', 'color_hex', 'accent_hex']) f[k].addEventListener('input', drawPreview);
    modal({ title: isNew ? 'New item' : `Edit ${it.sku}`, wide: true, body, actions: [{ label: 'Cancel' }, { label: isNew ? 'Create item' : 'Save changes', class: 'primary', onClick: async () => {
      const t = type.value, num = k => f[k].value === '' ? null : Number(f[k].value);
      const rec = {
        name: f.name.value.trim(), category: cat.value, uom: uom.value, barcode: bc.value.trim().toUpperCase(),
        price: t === 'raw' ? null : num('price'), lead_time_days: num('lead_time_days') ?? 0, ordering_policy: pol.value,
        reorder_point_override: num('reorder_point_override'), batch_size: made({ item_type: t }) ? num('batch_size') : null, active: active.checked,
        preferred_supplier_id: ['raw', 'resale'].includes(t) && sup.value ? Number(sup.value) : null,
        scent_family: made({ item_type: t }) ? fam.value || null : null, scent_notes: made({ item_type: t }) ? f.scent_notes.value.trim() || null : null,
        description: f.description.value.trim() || null, color_hex: f.color_hex.value, accent_hex: f.accent_hex.value,
      };
      if (!made({ item_type: t })) rec.std_cost = num('std_cost') ?? 0;
      // validation with clear messages
      if (!rec.name) throw new Error('Name is required.');
      if (!/^[A-Z0-9-]{3,20}$/.test(rec.barcode)) throw new Error('Barcode must be 3–20 letters, digits or dashes (Code 128 scans these reliably).');
      if (items.some(i => i.barcode === rec.barcode && i.id !== it?.id)) throw new Error(`Barcode ${rec.barcode} is already used by ${items.find(i => i.barcode === rec.barcode).sku}.`);
      if (t !== 'raw' && !(rec.price > 0)) throw new Error('Sellable items need a selling price greater than $0.');
      if (rec.std_cost != null && rec.std_cost < 0) throw new Error('Cost cannot be negative.');
      if (rec.lead_time_days < 0) throw new Error('Lead time cannot be negative.');
      if (made({ item_type: t }) && rec.batch_size != null && rec.batch_size < 1) throw new Error('Batch size must be at least 1.');
      let saved;
      if (isNew) {
        rec.sku = f.sku.value.trim().toUpperCase(); rec.item_type = t; rec.avg_cost = rec.std_cost ?? 0;
        if (!/^[A-Z0-9-]{3,20}$/.test(rec.sku)) throw new Error('SKU must be 3–20 letters, digits or dashes, e.g. CND-ALPINE.');
        if (items.some(i => i.sku === rec.sku)) throw new Error(`SKU ${rec.sku} already exists.`);
        [saved] = await q(sb.from('items').insert(rec).select());
      } else {
        [saved] = await q(sb.from('items').update(rec).eq('id', it.id).select());
      }
      if (!saved) throw new Error('Not saved: only managers can create or edit items.');
      // keep the supplier's price list in step so new POs default to this cost
      if (saved.preferred_supplier_id && ['raw', 'resale'].includes(t)) {
        const have = await q(sb.from('supplier_items').select('item_id').eq('supplier_id', saved.preferred_supplier_id).eq('item_id', saved.id));
        if (!have.length) await q(sb.from('supplier_items').insert({ supplier_id: saved.preferred_supplier_id, item_id: saved.id, unit_cost: saved.std_cost, supplier_sku: 'S' + saved.preferred_supplier_id + '-' + saved.sku }));
      }
      await reload();
      if (!isNew && !made(saved)) { const ch = await rollupStdCosts(); if (ch.length) toast(`Standard cost of ${ch.length} made item(s) updated from this cost`, 'info'); }
      toast(isNew ? `Created ${saved.sku} (barcode ${saved.barcode})${made(saved) ? ' — now add its BOM' : ''}` : `Saved ${saved.sku}`);
      view = saved.item_type; draw();
      if (isNew && made(saved)) setTimeout(() => openItem(items.find(i => i.id === saved.id)), 0);
      return true;
    } }] });
    showFor(); drawPreview();
  }

  draw();
  return onChange(['items'], () => reload().catch(() => {}), 800);
}
