import { getItems } from '../lib/db.js';
import { h, money, select, field, printNode, toast, typeLabel } from '../lib/ui.js';

export default async function labels(root) {
  const items = (await getItems()).filter(i => i.active);
  const copies = {};                       // item id -> count
  let type = 'finished';
  const typeSel = select([['finished', 'Finished goods'], ['kit', 'Gift sets'], ['resale', 'Resale'], ['raw', 'Raw materials'], ['', 'All items']], type, { onchange: e => { type = e.target.value; drawList(); } });
  const skip = h('input', { type: 'number', min: 0, max: 29, value: 0 });
  const showPrice = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'tbl-wrap tbl-scroll' });
  const preview = h('div', { style: { overflow: 'auto' } });

  function drawList() {
    const rows = items.filter(i => !type || i.item_type === type);
    list.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Barcode'), h('th', { class: 'num' }, 'Labels'))),
      h('tbody', {}, rows.map(i => h('tr', {}, h('td', {}, h('b', {}, i.sku), ' ', i.name, h('div', { class: 'muted' }, typeLabel(i.item_type))), h('td', {}, h('code', {}, i.barcode)),
        h('td', { class: 'num' }, h('input', { type: 'number', class: 'inline-in', min: 0, value: copies[i.id] || 0, oninput: e => { copies[i.id] = Number(e.target.value) || 0; drawPreview(); } })))))));
  }
  function sheetNodes() {
    const queue = [];
    for (let i = 0; i < Number(skip.value || 0); i++) queue.push(null);
    for (const it of items) for (let c = 0; c < (copies[it.id] || 0); c++) queue.push(it);
    const pages = [];
    for (let p = 0; p < queue.length; p += 30) {
      const sheet = h('div', { class: 'label-sheet', style: { pageBreakAfter: 'always', marginBottom: '16px' } });
      for (const it of queue.slice(p, p + 30)) {
        if (!it) { sheet.append(h('div', { class: 'label' })); continue; }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        if (window.JsBarcode) window.JsBarcode(svg, it.barcode, { format: 'CODE128', height: 40, width: 1.6, fontSize: 11, margin: 2, displayValue: true });
        sheet.append(h('div', { class: 'label' }, h('div', { class: 'ln' }, it.name), svg,
          h('div', { class: 'ls' }, it.sku + (showPrice.checked && it.price ? ' · ' + money(it.price) : '') + ' · Emblet Co.')));
      }
      pages.push(sheet);
    }
    return pages;
  }
  function drawPreview() {
    const pages = sheetNodes();
    const n = items.reduce((s, i) => s + (copies[i.id] || 0), 0);
    preview.replaceChildren(...(pages.length ? pages : [h('div', { class: 'empty' }, 'Set a label count on the left to preview a sheet.')]));
    countLbl.textContent = `${n} labels · ${pages.length} sheet(s)`;
  }
  const countLbl = h('span', { class: 'muted' });
  const quick = (n) => { for (const i of items.filter(i => !type || i.item_type === type)) copies[i.id] = n; drawList(); drawPreview(); };
  root.append(h('h1', {}, 'Print barcode labels'),
    h('p', { class: 'muted' }, 'Code 128 labels on an Avery 5160-style sheet (30 per letter page: 3 × 10, 2⅝″ × 1″). Print at 100% scale / “Actual size”, margins none. Scanned values work in POS, receiving, counts, transfers and returns.'),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'fields' }, field('Show', typeSel), field('Skip used labels on sheet', skip), field('Print price', showPrice)),
        h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'sm', onclick: () => quick(1) }, '1 of each'), h('button', { class: 'sm', onclick: () => quick(3) }, '3 of each'), h('button', { class: 'sm', onclick: () => quick(0) }, 'Clear')),
        list),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Sheet preview'), h('div', { class: 'spacer' }), countLbl,
        h('button', { class: 'primary', onclick: () => { const p = sheetNodes(); if (!p.length) return toast('Choose at least one label', 'err'); printNode(h('div', {}, p)); } }, '🖨 Print labels')), preview)));
  skip.addEventListener('input', drawPreview); showPrice.addEventListener('change', drawPreview);
  drawList(); drawPreview();
}
