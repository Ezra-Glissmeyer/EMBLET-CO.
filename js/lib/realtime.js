// One Supabase Realtime channel for the whole app; pages subscribe to table names.
import { sb } from './db.js';

const TABLES = ['inventory_balances', 'sales', 'sales_orders', 'so_lines', 'purchase_orders', 'production_orders', 'returns', 'ap_invoices', 'settings', 'items'];
const listeners = new Set();
let channel = null;
let statusCb = () => {};
let authSub = null;

// Realtime checks Row Level Security as the signed-in user, so it must be given the user's session token.
// With the new publishable keys (sb_publishable_…) the client otherwise connects with the key itself, and
// Realtime answers every change with "Error 401: Unauthorized" and an empty record.
async function authorize() {
  const { data } = await sb.auth.getSession();
  if (data.session?.access_token) await sb.realtime.setAuth(data.session.access_token);
}

let starting = null;
export function startRealtime(onStatus) {
  statusCb = onStatus || statusCb;
  if (channel) return Promise.resolve();
  return (starting ||= open().finally(() => { starting = null; }));
}
async function open() {
  await authorize();
  if (!authSub) {   // keep Realtime on the current token after automatic refreshes (about hourly)
    authSub = sb.auth.onAuthStateChange((event, session) => {
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session?.access_token) sb.realtime.setAuth(session.access_token);
    }).data.subscription;
  }
  channel = sb.channel('emblet-erp');
  for (const t of TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, payload => {
      if (payload.errors?.length) console.warn('Realtime:', t, payload.errors.join('; '));
      for (const l of listeners) if (l.tables.includes(t)) l.fire(payload);
    });
  }
  channel.subscribe(status => statusCb(status));
}
export function stopRealtime() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}

/** onChange(['sales','inventory_balances'], fn, debounceMs) -> unsubscribe */
export function onChange(tables, fn, wait = 350) {
  let timer = null; const batch = [];
  const l = {
    tables,
    fire: payload => { batch.push(payload); clearTimeout(timer); timer = setTimeout(() => { const b = batch.splice(0); fn(b); }, wait); },
  };
  listeners.add(l);
  return () => { clearTimeout(timer); listeners.delete(l); };
}
