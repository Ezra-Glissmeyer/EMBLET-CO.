// Tiny DOM + formatting toolkit (no framework).
import { friendly } from './db.js';

// Let replaceChildren / append skip null & false (so conditional children are easy)
for (const m of ['replaceChildren', 'append']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.filter(k => k != null && k !== false)); };
}

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- formatting ----------
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const money = (n, whole = false) => n == null || isNaN(n) ? '—' : (whole ? usd0 : usd).format(Number(n));
export const num = (n, dp = 0) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const qty = (n, uom = '') => {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n); const dp = Number.isInteger(v) ? 0 : (Math.abs(v) < 10 ? 2 : 1);
  return v.toLocaleString('en-US', { maximumFractionDigits: dp }) + (uom && uom !== 'ea' ? ' ' + uom : '');
};
export const pct = (n, dp = 1) => n == null || isNaN(n) ? '—' : Number(n).toFixed(dp) + '%';
export const fmtDate = d => {
  if (!d) return '—';
  const dt = typeof d === 'string' && d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
export const fmtDT = d => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const isoDate = (d = new Date()) => {
  const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10);
};
export const addDays = (d, n) => { const x = new Date(typeof d === 'string' ? d + 'T12:00:00' : d); x.setDate(x.getDate() + n); return isoDate(x); };
export const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

const STATUS = {
  ORDER_PLACED: ['Order Placed', 'blue'], PARTIALLY_FULFILLED: ['Partial / Backorder', 'amber'], FULFILLED: ['Fulfilled', 'green'],
  CLOSED: ['Closed', ''], CANCELLED: ['Cancelled', 'red'], ORDER_SENT: ['Order Sent', 'blue'], PARTIALLY_RECEIVED: ['Partially Received', 'amber'],
  RECEIVED: ['Received', 'green'], PLANNED: ['Planned', 'blue'], IN_PROGRESS: ['In Progress', 'amber'], COMPLETED: ['Completed', 'green'],
  OPEN: ['Open', 'amber'], PAID: ['Paid', 'green'], BELOW_ROP: ['Below ROP', 'red'], REVIEW: ['Review soon', 'amber'], OK: ['OK', 'green'],
  KEEP: ['Keep', 'green'], WATCH: ['Watch', 'amber'], REPLACE: ['Replace', 'red'], 'NO DATA': ['No data', ''],
};
export function badge(status, label) {
  const [l, c] = STATUS[status] || [status, ''];
  return h('span', { class: 'badge ' + c }, label || l);
}
export const typeLabel = t => ({ raw: 'Raw material', finished: 'Finished good', kit: 'Gift set (kit)', resale: 'Resale' }[t] || t);
export const locName = c => ({ WKS: 'Workshop – Orem', WHS: 'Warehouse – Springville', STR: 'Storefront – Provo', QAH: 'QA Hold' }[c] || c);

// ---------- feedback ----------
export function toast(msg, type = 'ok', ms = 3800) {
  const t = h('div', { class: 'toast ' + type, role: 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
export function showError(e) {
  const err = friendly(e);
  console.error(e);
  if (err.kind === 'short' && err.data?.length) {
    modal({
      title: 'Short on components',
      body: h('div', {}, h('p', {}, err.message),
        table([{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Component' }, { key: 'needed', label: 'Needed', num: true, fmt: r => qty(r.needed, r.uom) },
               { key: 'on_hand', label: 'On hand', num: true, fmt: r => qty(r.on_hand, r.uom) }, { key: 'short', label: 'Short', num: true, fmt: r => h('b', { style: 'color:var(--red)' }, qty(r.short, r.uom)) }], err.data),
        h('p', { class: 'hint' }, 'Transfer the components in from the Warehouse, receive an open PO, or reduce the quantity.')),
      actions: [{ label: 'OK', class: 'primary' }],
    });
  } else toast(err.message, 'err', 6500);
  return err;
}
// Run an async action from a button: disables it, shows a spinner, reports errors.
export async function run(btn, fn) {
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working…'; }
  try { return await fn(); }
  catch (e) { showError(e); return undefined; }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const foot = h('div', { class: 'modal-f' });
  for (const a of actions) {
    const b = h('button', { class: a.class || '', type: 'button' }, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      const res = await run(b, () => a.onClick(close, b));
      if (res !== false && a.closeOnSuccess !== false && res !== undefined) close();
    });
    foot.append(b);
  }
  const m = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-h' }, h('h2', {}, title), h('button', { class: 'ghost sm', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-b' }, body), actions.length ? foot : null);
  bg.append(m);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  const first = m.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: m };
}
export function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise(res => {
    let done = false;
    modal({ title, body: h('p', {}, text), onClose: () => { if (!done) res(false); },
      actions: [{ label: 'Cancel', onClick: () => { done = true; res(false); return true; } },
                { label: okLabel, class: danger ? 'danger solid' : 'primary', onClick: () => { done = true; res(true); return true; } }] });
  });
}

// ---------- tables ----------
// columns: [{key, label, num, fmt(row) -> node|string, cls(row)}]
export function table(columns, rows, opts = {}) {
  if (!rows || !rows.length) return empty(opts.empty || 'Nothing to show yet.', opts.emptyIcon);
  const thead = h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : '', title: c.title || '' }, c.label))));
  const tbody = h('tbody', {}, rows.map(r => {
    const tr = h('tr', { class: [opts.rowClass ? opts.rowClass(r) : '', opts.onRow ? 'click' : ''].join(' ') },
      columns.map(c => {
        const v = c.fmt ? c.fmt(r) : r[c.key];
        return h('td', { class: (c.num ? 'num ' : '') + (c.cls ? c.cls(r) : '') }, v == null ? '—' : v);
      }));
    if (opts.onRow) tr.addEventListener('click', e => { if (!e.target.closest('button,input,select,a')) opts.onRow(r); });
    return tr;
  }));
  const t = h('table', {}, thead, tbody);
  if (opts.foot) t.append(h('tfoot', {}, h('tr', {}, columns.map(c => h('td', { class: c.num ? 'num' : '' }, opts.foot[c.key] ?? '')))));
  return h('div', { class: 'tbl-wrap' + (opts.scroll ? ' tbl-scroll' : '') }, t);
}
export function empty(text, icon = '🕯️') { return h('div', { class: 'empty' }, h('span', { class: 'ic' }, icon), text); }
export function loading(text = 'Loading…') { return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' ', text); }

export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}
export function select(options, value, attrs = {}) {
  const s = h('select', attrs, options.map(o => {
    const [v, l] = Array.isArray(o) ? o : [o.value, o.label];
    return h('option', { value: v, selected: String(v) === String(value) }, l);
  }));
  return s;
}
export function tabs(names, active, onPick) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  names.forEach(([key, label]) => bar.append(h('button', { class: key === active ? 'on' : '', role: 'tab', onclick: () => {
    bar.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    bar.querySelector(`[data-k="${key}"]`).classList.add('on'); onPick(key);
  }, dataset: { k: key } }, label)));
  return bar;
}
export function kpi(k, v, s, cls = '', href) {
  return h(href ? 'a' : 'div', { class: 'kpi ' + cls, href }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
}

export function printNode(node) {
  const root = document.getElementById('print-root');
  root.innerHTML = '';
  root.append(node);
  setTimeout(() => { window.print(); }, 150);
}
export function downloadCSV(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// Chart.js helper (keeps one chart per canvas)
export const palette = ['#4F6B4A', '#C8A27A', '#9CAF88', '#94704A', '#4D6B85', '#B04A3A', '#B7832F', '#7E5BA6', '#6FB59A', '#E07B39'];
export function chart(canvas, config) {
  if (!window.Chart) { canvas.replaceWith(empty('Charts library did not load (offline?).')); return null; }
  if (canvas._chart) canvas._chart.destroy();
  window.Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  window.Chart.defaults.color = '#5C5548';
  canvas._chart = new window.Chart(canvas, config);
  return canvas._chart;
}
