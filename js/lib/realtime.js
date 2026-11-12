// One Supabase Realtime channel for the whole app; pages subscribe to table names.
import { sb } from './db.js';

const TABLES = ['inventory_balances', 'sales', 'sales_orders', 'so_lines', 'purchase_orders', 'production_orders', 'returns', 'ap_invoices', 'settings', 'items'];
const listeners = new Set();
let channel = null;
let statusCb = () => {};

export function startRealtime(onStatus) {
  statusCb = onStatus || statusCb;
  if (channel) return;
  channel = sb.channel('emblet-erp');
  for (const t of TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, payload => {
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
