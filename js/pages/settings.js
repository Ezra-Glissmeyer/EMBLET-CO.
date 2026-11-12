import { sb, q, getSettings, invalidateSettings } from '../lib/db.js';
import { h, field, select, run, toast, table, badge } from '../lib/ui.js';

export default async function settings(root, ctx) {
  const s = await getSettings(true);
  const f = {};
  const n = (k, step = 'any', scale = 1) => (f[k] = h('input', { type: 'number', step, value: +(s[k] * scale).toFixed(4), dataset: { scale } }));
  const t = k => (f[k] = h('input', { value: s[k] ?? '' }));
  root.append(h('h1', {}, 'Settings'), h('p', { class: 'muted' }, 'Stored in the database (settings table). Changing a value immediately changes every calculation that uses it — tax on new sales, ROP, EOQ, supplier ratings.'),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', {}, 'Sales'), field('Sales tax rate (%)', n('sales_tax_rate', '0.01', 100), 'Utah County combined rate is about 7.25%'),
        field('Wholesale price (% of retail)', n('wholesale_price_pct', '0.5', 100)), field('Wholesale payment terms (days)', n('wholesale_terms_days', '1')),
        field('Return policy (printed on receipts)', (f.return_policy = h('textarea', { rows: 3 }, s.return_policy)))),
      h('div', { class: 'card' }, h('h2', {}, 'Inventory ordering rules'), field('Ordering / setup cost per order ($)', n('ordering_cost', '0.01')),
        field('Annual holding cost (% of unit cost)', n('holding_cost_pct', '0.1', 100)), field('Service level z-value', n('service_z', '0.01'), '1.28 ≈ 90% · 1.65 ≈ 95% · 2.33 ≈ 99%'),
        field('Review period (days)', n('review_period_days', '1')), field('Usage history window (days)', n('usage_window_days', '1')), field('Candle cure time (days)', n('cure_days', '1'))),
      h('div', { class: 'card' }, h('h2', {}, 'Supplier rating thresholds'), field('Keep if score ≥', n('score_keep_min', '0.5')), field('Watch if score ≥ (else Replace)', n('score_watch_min', '0.5'))),
      h('div', { class: 'card' }, h('h2', {}, 'Company'), field('Company name', t('company_name')), field('Tagline', t('tagline')), field('Address', t('address')), field('Phone', t('phone')))),
    h('div', { class: 'row end', style: { marginTop: '14px' } }, h('button', { class: 'primary lg', onclick: e => run(e.target, async () => {
      const patch = { updated_at: new Date().toISOString() };
      for (const [k, el] of Object.entries(f)) patch[k] = el.type === 'number' ? Number(el.value) / Number(el.dataset.scale || 1) : el.value;
      if (patch.score_watch_min > patch.score_keep_min) throw new Error('The Watch threshold must be below the Keep threshold.');
      await q(sb.from('settings').update(patch).eq('id', 1));
      invalidateSettings(); toast('Settings saved');
    }) }, 'Save settings')));

  if (ctx.role === 'admin') {
    const users = await q(sb.from('profiles').select('*').order('role'));
    root.append(h('div', { class: 'card', style: { marginTop: '16px' } }, h('h2', {}, 'Users & roles (admin)'),
      h('p', { class: 'muted' }, 'New sign-ups start as customers. Admins can promote staff here; the database enforces what each role can do.'),
      table([{ key: 'full_name', label: 'Name' }, { key: 'email', label: 'Email' },
        { key: 'role', label: 'Role', fmt: u => select(['admin', 'manager', 'cashier', 'production', 'customer'].map(r => [r, r]), u.role, { onchange: async e => {
          try { await q(sb.from('profiles').update({ role: e.target.value }).eq('id', u.id)); toast(`${u.email} is now ${e.target.value}`); } catch (err) { toast(err.message, 'err'); } } }) },
        { key: 'default_location', label: 'Default location', fmt: u => u.default_location ? badge('x', u.default_location) : '—' }], users)));
  }
}
