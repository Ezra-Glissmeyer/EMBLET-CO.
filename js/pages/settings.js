import { sb, q, getSettings, invalidateSettings } from '../lib/db.js';
import { h, field, select, run, toast, table, badge, fmtDT, confirmBox } from '../lib/ui.js';
import { onChange } from '../lib/realtime.js';

// Validation rules (mirror the CHECK constraints in sql/01_schema.sql, with friendlier messages)
const RULES = {
  sales_tax_rate: [0, 0.25, 'Sales tax must be between 0% and 25%.'],
  wholesale_price_pct: [0.1, 1, 'Wholesale price must be between 10% and 100% of retail.'],
  wholesale_terms_days: [0, 120, 'Wholesale terms must be 0–120 days.'],
  ordering_cost: [0, 10000, 'Ordering cost must be $0 or more.'],
  holding_cost_pct: [0.0001, 2, 'Holding cost must be more than 0% (and at most 200%) per year.'],
  service_z: [0, 4, 'The z-value must be between 0 and 4 (1.65 ≈ 95% service level).'],
  review_period_days: [1, 90, 'Review period must be 1–90 days.'],
  usage_window_days: [14, 400, 'Usage window must be 14–400 days.'],
  cure_days: [0, 30, 'Cure time must be 0–30 days.'],
  score_keep_min: [0, 100, 'Keep threshold must be 0–100.'],
  score_watch_min: [0, 100, 'Watch threshold must be 0–100.'],
};

export default async function settings(root, ctx) {
  let dirty = false, ownSaveAt = 0;

  async function render() {
    const s = await getSettings(true);
    const f = {};
    const n = (k, step = 'any', scale = 1) => (f[k] = h('input', { type: 'number', step, value: +(Number(s[k]) * scale).toFixed(4), dataset: { scale }, oninput: () => { dirty = true; } }));
    const t = k => (f[k] = h('input', { value: s[k] ?? '', oninput: () => { dirty = true; } }));
    const saved = h('span', { class: 'muted' }, `Last saved ${fmtDT(s.updated_at)}`);
    const saveBtn = h('button', { class: 'primary lg', onclick: e => run(e.currentTarget, async () => {
      const patch = { updated_at: new Date().toISOString() };
      for (const [k, el] of Object.entries(f)) {
        if (el.type !== 'number') { patch[k] = el.value.trim(); continue; }
        if (el.value === '') throw new Error('Every number field needs a value.');
        const v = Number(el.value) / Number(el.dataset.scale || 1);
        const r = RULES[k]; if (r && (v < r[0] || v > r[1])) throw new Error(r[2]);
        patch[k] = v;
      }
      if (patch.score_watch_min > patch.score_keep_min) throw new Error('The Watch threshold must be below the Keep threshold.');
      if (!patch.company_name) throw new Error('Company name is required.');
      ownSaveAt = Date.now();
      const rows = await q(sb.from('settings').update(patch).eq('id', 1).select('updated_at'));
      // RLS silently filters rows it won't let you change — treat "0 rows" as a failure, never a fake success
      if (!rows.length) throw new Error('Not saved: your role is not allowed to change settings (managers and admins only).');
      dirty = false; invalidateSettings();
      toast('Settings saved — every ROP, EOQ, rating and new sale now uses these values');
      await render();
    }) }, 'Save settings');

    const kids = [
      h('div', { class: 'row' }, h('h1', {}, 'Settings'), h('div', { class: 'sp' }), saved),
      h('p', { class: 'muted' }, 'Stored in one row of the settings table. Saving changes every calculation that uses them immediately: tax on new sales, ROP, EOQ, safety stock, supplier ratings. Other signed-in users see the new values live.'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', {}, 'Sales'), field('Sales tax rate (%)', n('sales_tax_rate', '0.01', 100), 'Utah County combined rate is about 7.25%'),
          field('Wholesale price (% of retail)', n('wholesale_price_pct', '0.5', 100)), field('Wholesale payment terms (days)', n('wholesale_terms_days', '1')),
          field('Return policy (printed on receipts)', (f.return_policy = h('textarea', { rows: 3, oninput: () => { dirty = true; } }, s.return_policy)))),
        h('div', { class: 'card' }, h('h2', {}, 'Inventory ordering rules'), field('Ordering / setup cost per order ($)', n('ordering_cost', '0.01')),
          field('Annual holding cost (% of unit cost)', n('holding_cost_pct', '0.1', 100)), field('Service level z-value', n('service_z', '0.01'), '1.28 ≈ 90% · 1.65 ≈ 95% · 2.33 ≈ 99%'),
          field('Review period (days)', n('review_period_days', '1')), field('Usage history window (days)', n('usage_window_days', '1')), field('Candle cure time (days)', n('cure_days', '1'))),
        h('div', { class: 'card' }, h('h2', {}, 'Supplier rating thresholds'), field('Keep if score ≥', n('score_keep_min', '0.5')), field('Watch if score ≥ (else Replace)', n('score_watch_min', '0.5'))),
        h('div', { class: 'card' }, h('h2', {}, 'Company'), field('Company name', t('company_name')), field('Tagline', t('tagline')), field('Address', t('address')), field('Phone', t('phone')))),
      h('div', { class: 'row end', style: { marginTop: '14px' } }, saveBtn),
    ];

    if (ctx.role === 'admin') {
      const users = await q(sb.from('profiles').select('*').order('role').order('email'));
      kids.push(h('div', { class: 'card', style: { marginTop: '16px' } }, h('h2', {}, 'Users & roles (admin)'),
        h('p', { class: 'muted' }, 'New sign-ups start as customers. Promote staff here; the database (RLS + role checks in every function) enforces what each role can do. A changed role takes effect the next time that person signs in.'),
        table([{ key: 'full_name', label: 'Name' }, { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role', fmt: u => u.id === ctx.profile.id ? h('span', {}, badge('x', u.role), h('span', { class: 'muted' }, ' (you)'))
            : select(['admin', 'manager', 'cashier', 'production', 'customer'].map(r => [r, r]), u.role, { onchange: async e => {
              const sel = e.target, to = sel.value;
              if (!await confirmBox('Change role?', `Make ${u.email} a ${to}? They will see the ${to} menu next time they sign in.`, 'Change role')) { sel.value = u.role; return; }
              try {
                const rows = await q(sb.from('profiles').update({ role: to }).eq('id', u.id).select('role'));
                if (!rows.length) throw new Error('Not saved: only admins can change roles.');
                u.role = to; toast(`${u.email} is now ${to}`);
              } catch (err) { sel.value = u.role; toast(err.message, 'err', 6000); }
            } }) },
          { key: 'default_location', label: 'Default location', fmt: u => u.default_location ? badge('x', u.default_location) : '—' }], users)));
    }
    root.replaceChildren(...kids);
  }

  await render();
  // live: if someone else saves settings, refresh (unless you're mid-edit)
  return onChange(['settings'], () => {
    if (Date.now() - ownSaveAt < 5000) return;          // that event was our own save
    if (dirty) { toast('Another user just changed settings — save or reload to see their values.', 'info', 6000); return; }
    render().then(() => toast('Settings were updated by another user', 'info')).catch(() => {});
  }, 300);
}
