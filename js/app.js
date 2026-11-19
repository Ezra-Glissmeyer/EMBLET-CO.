// App shell: auth, role-based navigation, hash router, realtime status.
import { sb, q, configured, getItems, getLocations, invalidateItems, invalidateSettings } from './lib/db.js';
import { h, toast, showError, setLocNames } from './lib/ui.js';
import { startRealtime, stopRealtime, onChange } from './lib/realtime.js';

import { ROUTES, HOME, can, setRole } from './lib/nav.js';
export { ROUTES };

const state = { session: null, profile: null, cleanup: null, shell: null };
const app = document.getElementById('app');

// ---------------------------------------------------------------- login
function loginView() {
  app.className = '';
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@emblet.test' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  const msg = h('div', { class: 'err-text' });
  const btn = h('button', { class: 'primary block lg', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login-card', onsubmit: async e => {
    e.preventDefault(); msg.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) msg.textContent = error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message;
  } },
    h('h2', {}, 'Welcome back'),
    h('p', { class: 'muted' }, 'Sign in to the Emblet Co. operations system or the customer shop.'),
    !configured ? h('div', { class: 'callout bad' }, 'config.js still has placeholder values. Add your Supabase URL and anon key (see README).') : null,
    h('div', { class: 'field' }, h('label', {}, 'Email'), email),
    h('div', { class: 'field' }, h('label', {}, 'Password'), pw),
    btn, msg,
    h('div', { class: 'demo-logins' }, h('div', { class: 'muted' }, 'Demo accounts (passwords are in the README):'),
      ['manager', 'cashier', 'production', 'admin', 'customer', 'parkcity'].map(u =>
        h('button', { type: 'button', class: 'sm', onclick: () => { email.value = u + '@emblet.test'; pw.focus(); } }, u))));
  app.replaceChildren(h('div', { class: 'login-wrap' },
    h('div', { class: 'login-art' },
      h('div', { class: 'row' }, h('img', { src: 'assets/logo-mark.svg', width: 44, height: 44, alt: '' }), h('b', { style: { fontFamily: 'var(--serif)', fontSize: '1.3rem' } }, 'Emblet Co.')),
      h('div', {}, h('h1', {}, 'Hand-poured in the shadow of Timp.'),
        h('p', {}, 'Candles and melt-and-pour soap made in Orem, stocked in Springville, sold in Provo. One system for the whole trail: point of sale, inventory, production, purchasing, MRP and the books.')),
      h('div', { html: `<svg class="peaks" viewBox="0 0 600 160" preserveAspectRatio="none"><path d="M0 160 L0 110 L80 60 L130 95 L210 30 L290 100 L350 70 L430 120 L520 50 L600 100 L600 160 Z" fill="#9CAF88" opacity=".45"/><path d="M0 160 L0 130 L120 95 L220 125 L330 90 L450 130 L600 110 L600 160 Z" fill="#F5EBDD" opacity=".18"/></svg>` })),
    h('div', { class: 'login-form' }, form)));
  setTimeout(() => email.focus(), 50);
}

// ---------------------------------------------------------------- shell
function buildShell() {
  const p = state.profile;
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  let pendingGrp = null;
  for (const r of ROUTES) {
    if (r.grp) { pendingGrp = r.grp; continue; }
    if (!can(r, p.role)) continue;
    if (pendingGrp) { nav.append(h('div', { class: 'grp' }, pendingGrp)); pendingGrp = null; }
    nav.append(h('a', { href: '#/' + r.path, dataset: { path: r.path } }, h('span', { class: 'ic' }, r.ic), r.title,
      r.pill ? h('span', { class: 'pill', hidden: true, dataset: { pill: r.pill } }) : null));
  }
  const live = h('div', { class: 'live', title: 'Supabase Realtime connection' }, h('i'), h('span', {}, 'Connecting…'));
  const title = h('div', { class: 'title' });
  const content = h('main', { class: 'content', id: 'content' });
  const shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/' + HOME[p.role] }, h('img', { src: 'assets/logo-mark.svg', alt: '' }), h('div', {}, h('b', {}, 'Emblet Co.'), h('span', {}, p.role === 'customer' ? 'Candle & Soap Shop' : 'Mini ERP'))),
      nav,
      h('div', { class: 'me' }, h('b', {}, p.full_name || p.email), h('span', { class: 'role' }, p.role), h('br'),
        h('button', { class: 'sm', onclick: e => signOut(e.currentTarget) }, 'Sign out'))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'menu-btn sm', 'aria-label': 'Menu', onclick: () => shell.classList.toggle('nav-open') }, '☰'),
        title, h('div', { class: 'spacer' }), live,
        h('span', { class: 'who' }, (p.full_name || p.email).split(' ')[0], ' · ', p.role),
        h('button', { class: 'sm', title: 'Sign out', onclick: e => signOut(e.currentTarget) }, 'Sign out')),
      content));
  nav.addEventListener('click', () => shell.classList.remove('nav-open'));
  app.className = '';
  app.replaceChildren(shell);
  state.shell = { shell, nav, title, content, live };
  startRealtime(status => {
    live.classList.toggle('on', status === 'SUBSCRIBED');
    live.lastChild.textContent = status === 'SUBSCRIBED' ? 'Live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'Realtime offline' : 'Connecting…';
  });
  // global realtime behaviours
  if (p.role !== 'customer') {
    onChange(['items'], () => invalidateItems());
    onChange(['settings'], () => invalidateSettings());
    onChange(['sales_orders'], batch => {
      for (const ev of batch) {
        if (ev.eventType === 'INSERT' && ev.new.channel === 'ONLINE_PICKUP') toast(`🛍️ New pickup order ${ev.new.so_no} — see Sales Orders`, 'info', 7000);
      }
      refreshPills();
    }, 200);
    refreshPills();
  }
}
async function refreshPills() {
  try {
    const { count } = await sb.from('sales_orders').select('id', { count: 'exact', head: true })
      .eq('channel', 'ONLINE_PICKUP').in('status', ['ORDER_PLACED', 'PARTIALLY_FULFILLED']);
    document.querySelectorAll('[data-pill="open_pickups"]').forEach(el => { el.textContent = count; el.hidden = !count; });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- router
let routeSeq = 0;   // every navigation gets a ticket; a page that finishes loading after you've moved on is thrown away
async function route() {
  if (!state.profile) return;
  if (!location.hash.replace(/^#\/?/, '')) history.replaceState(null, '', '#/' + HOME[state.profile.role]);   // land on this role's home page
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const r = ROUTES.find(x => x.path === path);
  if (!r || !can(r, state.profile.role)) { location.hash = '#/' + HOME[state.profile.role]; return; }
  const ticket = ++routeSeq;
  // close any dialog left open (e.g. clicking a link inside an item window); Escape runs each dialog's own close/cleanup
  if (document.querySelector('.modal-bg')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  const { nav, title, content } = state.shell;
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.path === path));
  title.textContent = r.title;
  document.title = r.title + ' · Emblet Co.';
  content.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' Loading ', r.title, '…'));
  try {
    const mod = await import(r.mod);
    if (ticket !== routeSeq) return;
    const ctx = { profile: state.profile, role: state.profile.role, params: new URLSearchParams(qs || ''), go: p => { location.hash = '#/' + p; } };
    const node = h('div');
    const cleanup = await mod.default(node, ctx);
    if (ticket !== routeSeq) {                       // user navigated away while this page was loading
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      return;
    }
    content.replaceChildren(node);
    state.cleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (e) {
    if (ticket !== routeSeq) return;
    content.replaceChildren(h('div', { class: 'callout bad' }, 'This page could not load: ', e.message || String(e)));
    showError(e);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- sign out
// Must ALWAYS work. supabase-js keeps the session if the server's /logout call fails (network blip, 5xx),
// so: end the session locally (no network needed), wipe any stored token, and reload to the login page.
async function signOut(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Signing out…'; }
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  try { stopRealtime(); } catch { /* ignore */ }
  try { await Promise.race([sb.auth.signOut({ scope: 'local' }), new Promise(r => setTimeout(r, 2500))]); } catch { /* ignore */ }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('sb-') && k.includes('auth-token')) localStorage.removeItem(k);
  } catch { /* storage blocked: nothing stored either */ }
  location.replace(location.pathname + location.search);   // fresh page, no #/route, shows the login screen
}

// ---------------------------------------------------------------- auth bootstrap
async function onSession(session) {
  state.session = session;
  if (!session) {
    if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
    state.profile = null; stopRealtime();
    history.replaceState(null, '', location.pathname + location.search);   // next person starts on their own home page
    loginView(); return;
  }
  try {
    const prof = await q(sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
    if (!prof) throw new Error('No profile found for this login. Run the SQL setup files (03_rls.sql creates profiles on signup).');
    state.profile = prof;
    setRole(prof.role);
    setLocNames(await getLocations());
    if (prof.role !== 'customer') getItems().catch(() => {});
    buildShell();
    route();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'card', style: { maxWidth: '480px' } },
      h('h2', {}, 'Could not load your account'), h('p', {}, e.message || String(e)),
      h('button', { onclick: e => signOut(e.currentTarget) }, 'Sign out'))));
  }
}
let lastUser = undefined;
sb.auth.onAuthStateChange((event, session) => {
  const uid = session?.user?.id || null;
  if (uid === lastUser && event !== 'SIGNED_OUT') return;   // token refreshes don't rebuild the app
  lastUser = uid;
  setTimeout(() => onSession(session), 0);
});
