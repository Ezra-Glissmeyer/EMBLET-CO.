import { sb, q, getItems, invalidateItems } from '../lib/db.js';
import { h, money, qty, pct, num, fmtDate, badge, table, tabs, modal, field, select, toast, chart, palette, loading, confirmBox, run } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

export default async function suppliersPage(root) {
  const items = await getItems();
  let view = 'score';
  const body = h('div');
  root.append(h('div', { class: 'row' }, h('h1', {}, 'Suppliers & scorecard'), h('div', { class: 'sp' }), h('button', { class: 'primary', onclick: () => edit() }, '+ Add supplier')),
    tabs([['score', 'Scorecard'], ['list', 'Supplier directory']], view, k => { view = k; render(); }), body);
  const render = () => (view === 'score' ? score() : list()).catch(e => body.replaceChildren(h('div', { class: 'callout bad' }, e.message)));

  async function score() {
    body.replaceChildren(loading());
    const rows = await q(sb.from('v_supplier_scorecard').select('*').order('overall_score', { ascending: false }));
    const keep = rows[0]?.score_keep_min ?? 90, watch = rows[0]?.score_watch_min ?? 75;
    const cv = h('canvas', { height: 90 });
    body.replaceChildren(
      h('div', { class: 'callout', style: { marginBottom: '12px' } },
        h('b', {}, 'How the rating is computed (from PO history only): '),
        'Overall = 40% × on-time rate + 30% × fill rate + 30% × lead-time accuracy. ',
        'On-time = first receipt on or before the PO\'s expected date. Fill rate = qty received ÷ qty ordered. Lead-time accuracy = 1 − |avg actual − quoted| ÷ quoted. ',
        h('span', {}, 'Thresholds: '), badge('KEEP', `Keep ≥ ${keep}`), ' ', badge('WATCH', `Watch ${watch}–${keep}`), ' ', badge('REPLACE', `Replace < ${watch}`), ' (editable in Settings)'),
      table([
        { key: 'name', label: 'Supplier', fmt: r => h('div', {}, h('b', {}, r.name), h('div', { class: 'muted' }, `${r.contact_name} · ${r.payment_terms}`)) },
        { key: 'pos_received', label: 'POs', num: true },
        { key: 'on_time_pct', label: 'On-time', num: true, fmt: r => pct(r.on_time_pct) },
        { key: 'lt', label: 'Lead time: actual vs quoted', num: true, fmt: r => h('span', { style: { color: r.avg_actual_lead > r.quoted_lead_days + 0.5 ? 'var(--red)' : '' } }, `${num(r.avg_actual_lead, 1)} vs ${r.quoted_lead_days} d`) },
        { key: 'lead_accuracy_pct', label: 'LT accuracy', num: true, fmt: r => pct(r.lead_accuracy_pct) },
        { key: 'fill_rate_pct', label: 'Fill rate', num: true, fmt: r => h('span', { style: { color: r.fill_rate_pct < 95 ? 'var(--red)' : '' } }, pct(r.fill_rate_pct)) },
        { key: 'overall_score', label: 'Score', num: true, fmt: r => h('b', { style: { fontSize: '1.1em' } }, num(r.overall_score, 1)) },
        { key: 'rating', label: 'Rating', fmt: r => badge(r.rating) },
        { key: 'open', label: 'Open invoices', num: true, fmt: r => `${r.open_invoices} · ${money(r.amount_owed)}` },
        { key: 'next_due_date', label: 'Next due', fmt: r => fmtDate(r.next_due_date) },
        { key: 'pd', label: 'Past due', fmt: r => r.past_due_invoices ? badge('BELOW_ROP', `${r.past_due_invoices} · ${money(r.past_due_amount)}`) : badge('OK', 'none') },
      ], rows),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', {}, 'Average actual vs quoted lead time (days)'), cv),
      h('p', { class: 'hint' }, 'Pay or review invoices under Purchasing → A/P invoices.'));
    chart(cv, { type: 'bar', data: { labels: rows.map(r => r.name), datasets: [
      { label: 'Quoted', data: rows.map(r => r.quoted_lead_days), backgroundColor: palette[1] },
      { label: 'Actual (avg)', data: rows.map(r => r.avg_actual_lead), backgroundColor: palette[0] }] }, options: { plugins: { legend: { position: 'bottom' } } } });
  }

  async function list() {
    body.replaceChildren(loading());
    const rows = await q(sb.from('suppliers').select('*, supplier_items(item_id)').order('name'));
    body.replaceChildren(table([
      { key: 'name', label: 'Supplier', fmt: r => h('b', {}, r.name) }, { key: 'contact_name', label: 'Contact' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' }, { key: 'quoted_lead_days', label: 'Lead (d)', num: true }, { key: 'payment_terms', label: 'Terms' },
      { key: 'n', label: 'Items', num: true, fmt: r => r.supplier_items.length }, { key: 'active', label: '', fmt: r => r.active ? '' : badge('CANCELLED', 'Inactive') },
    ], rows, { onRow: r => edit(r.id) }));
  }

  async function edit(id) {
    const s = id ? await q(sb.from('suppliers').select('*').eq('id', id).single()) : { name: '', quoted_lead_days: 7, payment_terms: 'Net 30', active: true };
    let si = id ? await q(sb.from('supplier_items').select('*, items(sku, name, uom)').eq('supplier_id', id)) : [];
    const f = {};
    const inp = (k, type = 'text') => (f[k] = h('input', { type, value: s[k] ?? '' }));
    const terms = (f.payment_terms = select(['Net 15', 'Net 30', 'Net 45', '2/10 Net 30'].map(t => [t, t]), s.payment_terms));
    const active = (f.active = h('input', { type: 'checkbox', checked: s.active }));
    const siBox = h('div');
    const drawSI = () => siBox.replaceChildren(id ? h('div', {}, h('h3', {}, 'Items supplied & cost'),
      table([{ key: 'i', label: 'Item', fmt: r => `${r.items.sku} · ${r.items.name}` },
        { key: 'unit_cost', label: 'Unit cost', num: true, fmt: r => h('input', { type: 'number', step: '0.0001', class: 'inline-in', value: r.unit_cost, onchange: e => run(null, async () => {
          const v = Number(e.target.value);
          if (e.target.value === '' || !(v >= 0)) { e.target.value = r.unit_cost; throw new Error('Cost must be $0 or more.'); }
          const rows = await q(sb.from('supplier_items').update({ unit_cost: v }).eq('supplier_id', id).eq('item_id', r.item_id).select());
          if (!rows.length) throw new Error('Not saved: only managers can change supplier costs.');
          r.unit_cost = v; toast(`${r.items.sku}: new POs to this supplier will default to ${money(v)}`);
        }) }) },
        { key: 'm', label: 'Min order', num: true, fmt: r => qty(r.min_order_qty, r.items.uom) },
        { key: 'x', label: '', fmt: r => h('button', { class: 'sm ghost', onclick: () => run(null, async () => {
          const rows = await q(sb.from('supplier_items').delete().eq('supplier_id', id).eq('item_id', r.item_id).select());
          if (!rows.length) throw new Error('Not removed: only managers can change supplier items.');
          si = si.filter(x => x.item_id !== r.item_id); drawSI(); }) }, '✕') }], si, { empty: 'No items linked yet.' }),
      (() => { const sel = select([['', 'Add an item…'], ...items.filter(i => ['raw', 'resale'].includes(i.item_type) && !si.some(x => x.item_id === i.id)).map(i => [i.id, `${i.sku} · ${i.name}`])], '');
        const c = h('input', { type: 'number', step: '0.0001', class: 'inline-in', placeholder: 'cost' });
        return h('div', { class: 'row', style: { marginTop: '8px' } }, sel, c, h('button', { class: 'sm', onclick: e => run(e.currentTarget, async () => {
          if (!sel.value || c.value === '' || !(Number(c.value) >= 0)) throw new Error('Choose an item and enter its cost.');
          const [row] = await q(sb.from('supplier_items').insert({ supplier_id: id, item_id: Number(sel.value), unit_cost: Number(c.value) }).select('*, items(sku, name, uom)'));
          if (!row) throw new Error('Not saved: only managers can change supplier items.');
          si.push(row); drawSI(); }) }, 'Add')); })()) : h('p', { class: 'hint' }, 'Save the supplier first, then link the items they supply.'));
    drawSI();
    modal({ title: id ? 'Edit supplier' : 'New supplier', wide: true, body: h('div', {},
      h('div', { class: 'fields' }, field('Name', inp('name')), field('Contact name', inp('contact_name')), field('Email', inp('email', 'email')), field('Phone', inp('phone'))),
      field('Address', inp('address')), h('div', { class: 'fields' }, field('Quoted lead time (days)', inp('quoted_lead_days', 'number')), field('Payment terms', terms), field('Active', active)),
      field('Notes', inp('notes')), siBox),
      actions: [...(id ? [{ label: 'Delete', class: 'danger', onClick: async () => {
        if (!await confirmBox('Delete supplier?', 'Suppliers with PO history cannot be deleted — mark them inactive instead.', 'Delete', true)) return false;
        try {
          const rows = await q(sb.from('suppliers').delete().eq('id', id).select());
          if (!rows.length) throw new Error('Not deleted: only managers can delete suppliers.');
        } catch (e) {
          if (/foreign key|violates/i.test(e.message)) throw new Error(`${s.name} has purchase orders or items on file, so it can't be deleted (that would erase its history and scorecard). Untick "Active" instead.`);
          throw e;
        }
        toast('Deleted'); render(); return true; } }] : []),
        { label: 'Cancel' }, { label: 'Save', class: 'primary', onClick: async () => {
          const rec = { name: f.name.value.trim(), contact_name: f.contact_name.value, email: f.email.value, phone: f.phone.value, address: f.address.value,
            quoted_lead_days: Number(f.quoted_lead_days.value), payment_terms: terms.value, notes: f.notes.value, active: active.checked };
          if (!rec.name) throw new Error('Supplier name is required.');
          if (!(rec.quoted_lead_days >= 0)) throw new Error('Lead time must be zero or more days.');
          if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) throw new Error('That email address doesn\'t look right.');
          const rows = id ? await q(sb.from('suppliers').update(rec).eq('id', id).select()) : await q(sb.from('suppliers').insert(rec).select());
          if (!rows.length) throw new Error('Not saved: only managers can edit suppliers.');
          // keep item lead times in step with the supplier's quoted lead time (ROP and expected dates use them)
          if (id && rec.quoted_lead_days !== s.quoted_lead_days) {
            const its = await q(sb.from('items').select('id, sku').eq('preferred_supplier_id', id));
            if (its.length && await confirmBox('Update item lead times?', `Change the lead time on ${its.length} item(s) that ${rec.name} supplies from ${s.quoted_lead_days} to ${rec.quoted_lead_days} days? Their reorder points will recalculate.`, 'Update items')) {
              await q(sb.from('items').update({ lead_time_days: rec.quoted_lead_days }).eq('preferred_supplier_id', id).select('id'));
              invalidateItems(); toast(`${its.length} item lead time(s) updated to ${rec.quoted_lead_days} days`, 'info');
            }
          }
          toast('Supplier saved'); render(); return true; } }] });
  }
  render();
  return onChange(['purchase_orders', 'ap_invoices'], () => { if (view === 'score') render(); }, 800);
}
