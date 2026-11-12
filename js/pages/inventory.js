import { sb, q, rpc, getItems, getLocations, getReasons, findItem } from '../lib/db.js';
import { h, money, qty, fmtDT, badge, table, tabs, toast, run, select, field, empty, loading, typeLabel, downloadCSV, modal } from '../lib/ui.js';
import { scanField } from '../lib/scanner.js';
import { onChange } from '../lib/realtime.js';

export default async function inventory(root, ctx) {
  const [items, locs, adjReasons] = await Promise.all([getItems(), getLocations(), getReasons('ADJUST')]);
  let view = ctx.params.get('tab') || 'grid';
  const body = h('div');
  root.append(h('div', { class: 'row' }, h('h1', {}, 'Inventory'), h('div', { class: 'sp' }),
      h('a', { class: 'btn', href: '#/purchasing?tab=receive' }, '📥 Scan to receive (PO)'), h('a', { class: 'btn', href: '#/orders' }, 'Backorders →')),
    h('p', { class: 'muted' }, 'On-hand quantities come from a single append-only inventory ledger; the balance table is maintained from it and reconciles exactly.'),
    tabs([['grid', 'On hand by location'], ['transfer', 'Transfer'], ['adjust', 'Adjust'], ['count', 'Cycle count'], ['ledger', 'Item history (ledger)']], view, k => { view = k; render(); }), body);

  const itemPicker = (onPick, filter = () => true) => {
    const info = h('div', { class: 'hint' });
    const sel = select([['', 'Choose item…'], ...items.filter(i => i.active && filter(i)).map(i => [i.id, `${i.sku} · ${i.name}`])], '', { onchange: () => { const it = items.find(x => x.id == sel.value); info.textContent = it ? `${typeLabel(it.item_type)} · ${it.uom} · barcode ${it.barcode}` : ''; onPick(it); } });
    const scan = scanField({ onScan: async code => { const it = await findItem(code); if (!it) { toast('Unknown barcode ' + code, 'err'); return false; } sel.value = it.id; sel.dispatchEvent(new Event('change')); return true; } });
    return { el: h('div', {}, field('Scan item', scan), field('…or choose', sel), info), get: () => items.find(x => x.id == sel.value) };
  };
  const locSel = (v, opts = {}) => select(locs.map(l => [l.code, l.name]), v, opts);

  function render() {
    const f = { grid, transfer, adjust, count, ledger }[view];
    f().catch(e => body.replaceChildren(h('div', { class: 'callout bad' }, e.message)));
  }

  // ---------------- grid
  let gridRows = [], gf = { type: '', loc: '', low: false, s: '' };
  async function grid(reload = true) {
    if (reload || !gridRows.length) { body.replaceChildren(loading()); gridRows = await rpc('fn_inventory_grid'); }
    const typeSel = select([['', 'All types'], ['raw', 'Raw materials'], ['finished', 'Finished goods'], ['kit', 'Gift sets'], ['resale', 'Resale']], gf.type, { onchange: e => { gf.type = e.target.value; grid(false); } });
    const lSel = select([['', 'All locations'], ...locs.map(l => [l.code, l.name])], gf.loc, { onchange: e => { gf.loc = e.target.value; grid(false); } });
    const low = h('label', { class: 'row', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: gf.low, onchange: e => { gf.low = e.target.checked; grid(false); } }), 'Below ROP / review only');
    const s = h('input', { type: 'search', placeholder: 'Search SKU or name', value: gf.s, onchange: e => { gf.s = e.target.value; grid(false); } });
    const rows = gridRows.filter(r => (!gf.type || r.item_type === gf.type) && (!gf.low || r.status !== 'OK')
      && (!gf.s || (r.sku + r.name).toLowerCase().includes(gf.s.toLowerCase())) && (!gf.loc || Number(r[gf.loc.toLowerCase()]) !== 0));
    const lc = c => gf.loc && gf.loc !== c ? 'muted' : '';
    const total = rows.reduce((t, r) => t + Number(r.value), 0);
    body.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '10px' } }, typeSel, lSel, s, low, h('div', { class: 'sp' }),
        h('button', { class: 'sm', onclick: () => downloadCSV('inventory.csv', rows) }, 'Export CSV')),
      table([
        { key: 'sku', label: 'SKU', fmt: r => h('b', {}, r.sku) }, { key: 'name', label: 'Item' },
        { key: 'item_type', label: 'Type', fmt: r => h('span', { class: 'muted' }, typeLabel(r.item_type)) },
        ...['WKS', 'WHS', 'STR', 'QAH'].map(c => ({ key: c, label: c, num: true, cls: () => lc(c), fmt: r => qty(r[c.toLowerCase()]) })),
        { key: 'total', label: 'Total', num: true, fmt: r => h('b', {}, qty(r.total, r.uom)) },
        { key: 'on_order', label: 'On order', num: true, fmt: r => qty(r.on_order) },
        { key: 'rop', label: 'ROP', num: true, fmt: r => qty(r.rop) },
        { key: 'status', label: 'Status', fmt: r => badge(r.status) },
        { key: 'avg_cost', label: 'Avg cost', num: true, fmt: r => money(r.avg_cost) },
        { key: 'value', label: 'Value', num: true, fmt: r => money(r.value) },
      ], rows, { onRow: r => { view = 'ledger'; ledgerItem = r.item_id; render(); }, rowClass: r => r.status === 'BELOW_ROP' ? 'low' : r.status === 'REVIEW' ? 'warn' : '', scroll: true,
        foot: { sku: `${rows.length} items`, value: money(total) }, empty: 'No items match these filters.' }),
      h('p', { class: 'hint' }, 'Tip: click a row to see that item\'s full transaction history.')));
  }

  // ---------------- transfer
  async function transfer() {
    const pk = itemPicker(() => showOH());
    const from = locSel('WKS', { onchange: () => showOH() }), to = locSel('STR');
    const amt = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Quantity' });
    const note = h('input', { placeholder: 'Optional note (e.g. Restock storefront)' });
    const oh = h('div', { class: 'hint' });
    async function showOH() {
      const it = pk.get(); if (!it) return oh.textContent = '';
      const b = await q(sb.from('inventory_balances').select('location_code, qty').eq('item_id', it.id));
      oh.textContent = 'On hand: ' + locs.map(l => `${l.code} ${qty(b.find(x => x.location_code === l.code)?.qty || 0)}`).join(' · ');
    }
    body.replaceChildren(h('div', { class: 'card', style: { maxWidth: '720px' } }, h('h2', {}, 'Transfer between locations'), pk.el, oh,
      h('div', { class: 'fields' }, field('From', from), field('To', to), field('Quantity', amt)), field('Note', note),
      h('button', { class: 'primary', onclick: e => run(e.target, async () => {
        const it = pk.get(); if (!it) throw new Error('Choose or scan an item.');
        if (!(Number(amt.value) > 0)) throw new Error('Enter a quantity greater than zero.');
        const r = await rpc('transfer_inventory', { p_item_id: it.id, p_from: from.value, p_to: to.value, p_qty: Number(amt.value), p_note: note.value || null });
        toast(`${r.transfer_no}: moved ${amt.value} ${it.uom} of ${it.name} ${from.value} → ${to.value}`); amt.value = ''; showOH();
      }) }, 'Post transfer')));
  }

  // ---------------- adjust
  async function adjust() {
    const pk = itemPicker(() => {});
    const loc = locSel(ctx.profile.default_location || 'WKS');
    const dir = select([['-1', 'Remove (−)'], ['1', 'Add (+)']], '-1');
    const amt = h('input', { type: 'number', min: 0, step: 'any' });
    const reason = select([['', 'Choose reason code…'], ...adjReasons.filter(r => r.code !== 'CYCLE_COUNT').map(r => [r.code, `${r.code} — ${r.description}`])], '');
    const note = h('input', { placeholder: 'What happened?' });
    body.replaceChildren(h('div', { class: 'card', style: { maxWidth: '720px' } }, h('h2', {}, 'Inventory adjustment'),
      h('p', { class: 'muted' }, 'Damage, spoilage, testers and found stock. Every adjustment requires a reason code and posts to the GL (Inventory Adjustment or Scrap / Write-off).'),
      pk.el, h('div', { class: 'fields' }, field('Location', loc), field('Direction', dir), field('Quantity', amt)), field('Reason code', reason), field('Note', note),
      h('button', { class: 'primary', onclick: e => run(e.target, async () => {
        const it = pk.get(); if (!it) throw new Error('Choose or scan an item.');
        if (!reason.value) throw new Error('A reason code is required.');
        const n = Number(amt.value) * Number(dir.value); if (!n) throw new Error('Enter a quantity.');
        const r = await rpc('adjust_inventory', { p_item_id: it.id, p_location: loc.value, p_qty_change: n, p_reason_code: reason.value, p_note: note.value || null });
        toast(`${r.adjustment_no} posted. New on hand at ${loc.value}: ${qty(r.new_on_hand, it.uom)}`); amt.value = '';
      }) }, 'Post adjustment')));
  }

  // ---------------- cycle count
  async function count() {
    const loc = locSel(ctx.profile.default_location || 'STR');
    const blind = h('input', { type: 'checkbox', checked: true });
    const results = [];
    const cur = h('div');
    const resBox = h('div');
    const drawRes = () => resBox.replaceChildren(table([
      { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'loc', label: 'Loc' },
      { key: 'sys', label: 'System', num: true, fmt: r => qty(r.system_qty) }, { key: 'cnt', label: 'Counted', num: true, fmt: r => qty(r.counted_qty) },
      { key: 'var', label: 'Variance', num: true, fmt: r => h('b', { style: { color: r.variance ? 'var(--red)' : 'var(--green)' } }, (r.variance > 0 ? '+' : '') + qty(r.variance)) },
      { key: 'val', label: 'Value', num: true, fmt: r => money(r.variance_value) }, { key: 'adj', label: 'Posted', fmt: r => r.adjustment_no || 'no change' },
    ], results, { empty: 'Counted items will list here.' }));
    async function pick(it) {
      const sys = Number((await q(sb.from('inventory_balances').select('qty').eq('item_id', it.id).eq('location_code', loc.value).maybeSingle()))?.qty || 0);
      const counted = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Counted quantity' });
      const post = async () => {
        if (counted.value === '') throw new Error('Enter the counted quantity.');
        const r = await rpc('cycle_count', { p_item_id: it.id, p_location: loc.value, p_counted_qty: Number(counted.value) });
        results.unshift({ ...r, sku: it.sku, name: it.name, loc: loc.value }); drawRes(); cur.replaceChildren();
        toast(r.variance ? `Variance ${r.variance > 0 ? '+' : ''}${qty(r.variance)} posted (${r.adjustment_no})` : 'Count matches the system ✔'); scan.focus();
      };
      counted.addEventListener('keydown', e => { if (e.key === 'Enter') run(null, post); });
      cur.replaceChildren(h('div', { class: 'card', style: { background: 'var(--paper)' } }, h('h3', {}, `${it.sku} · ${it.name}`),
        h('div', { class: 'muted' }, blind.checked ? 'Blind count — system quantity hidden until you post.' : `System says ${qty(sys, it.uom)} at ${loc.value}.`),
        h('div', { class: 'row', style: { marginTop: '8px' } }, counted, h('button', { class: 'primary', onclick: e => run(e.target, post) }, 'Post count'))));
      setTimeout(() => counted.focus(), 30);
    }
    const scan = scanField({ autofocus: true, continuous: false, onScan: async code => { const it = await findItem(code); if (!it) { toast('Unknown barcode ' + code, 'err'); return false; } pick(it); return true; } });
    const sel = select([['', 'Choose item…'], ...items.filter(i => i.active).map(i => [i.id, `${i.sku} · ${i.name}`])], '', { onchange: e => { const it = items.find(i => i.id == e.target.value); if (it) pick(it); } });
    body.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Cycle count'),
      h('p', { class: 'muted' }, 'Scan an item, enter what you physically count. The system computes the variance and posts a CYCLE_COUNT adjustment (and GL entry) automatically.'),
      h('div', { class: 'fields' }, field('Counting at', loc), field('Scan item', scan), field('…or choose', sel)),
      h('label', { class: 'row' }, blind, 'Blind count (hide system quantity)'), cur), h('div', { class: 'card' }, h('h3', {}, 'This session'), resBox));
    drawRes();
  }

  // ---------------- ledger
  let ledgerItem = null;
  async function ledger() {
    const sel = select([['', 'Choose item…'], ...items.map(i => [i.id, `${i.sku} · ${i.name}`])], ledgerItem || '', { onchange: e => { ledgerItem = Number(e.target.value); ledger(); } });
    const scan = scanField({ onScan: async code => { const it = await findItem(code); if (!it) return false; ledgerItem = it.id; ledger(); return true; } });
    const out = h('div');
    body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'fields' }, field('Scan item', scan), field('Item', sel)), out));
    if (!ledgerItem) return out.replaceChildren(empty('Pick an item to see every receipt, sale, transfer, adjustment and production movement.'));
    out.replaceChildren(loading());
    const it = items.find(i => i.id === ledgerItem);
    const rows = await q(sb.from('inventory_transactions').select('*').eq('item_id', ledgerItem).order('txn_at', { ascending: true }).order('id').limit(5000));
    let tot = 0; const bal = {};
    for (const r of rows) { tot += Number(r.qty); bal[r.location_code] = (bal[r.location_code] || 0) + Number(r.qty); r.running = tot; }
    rows.reverse();
    out.replaceChildren(
      h('div', { class: 'row', style: { margin: '8px 0' } }, h('b', {}, `${it.sku} · ${it.name}`), h('span', { class: 'muted' }, `${rows.length} transactions · avg cost ${money(it.avg_cost)}/${it.uom}`),
        h('span', { class: 'sp' }), ...Object.entries(bal).map(([l, v]) => badge('x', `${l}: ${qty(v)}`)), badge('OK', `Total ${qty(tot, it.uom)}`)),
      table([
        { key: 'txn_at', label: 'When', fmt: r => fmtDT(r.txn_at) }, { key: 'txn_type', label: 'Type', fmt: r => badge('x', r.txn_type.replace('_', ' ')) },
        { key: 'location_code', label: 'Loc' }, { key: 'qty', label: 'Qty', num: true, fmt: r => h('b', { style: { color: r.qty < 0 ? 'var(--red)' : 'var(--green)' } }, (r.qty > 0 ? '+' : '') + qty(r.qty)) },
        { key: 'unit_cost', label: 'Unit cost', num: true, fmt: r => money(r.unit_cost) }, { key: 'running', label: 'Running total', num: true, fmt: r => qty(r.running) },
        { key: 'ref_no', label: 'Reference' }, { key: 'reason_code', label: 'Reason' }, { key: 'note', label: 'Note', fmt: r => h('span', { class: 'muted' }, r.note || '') },
      ], rows, { scroll: true }));
  }

  render();
  return onChange(['inventory_balances'], () => { if (view === 'grid') grid(true).catch(() => {}); }, 700);
}
