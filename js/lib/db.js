// Supabase client + small helpers that turn {data, error} into exceptions with friendly messages.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
});

export class AppError extends Error {
  constructor(message, kind = 'error', data = null) { super(message); this.kind = kind; this.data = data; }
}

// Translate Postgres / PostgREST errors into something a cashier can act on.
export function friendly(err) {
  if (!err) return new AppError('Unknown error');
  if (err instanceof AppError) return err;
  const msg = err.message || String(err);
  if (msg.startsWith('SHORT_COMPONENTS:')) {
    let list = [];
    try { list = JSON.parse(msg.slice('SHORT_COMPONENTS:'.length)); } catch { /* ignore */ }
    return new AppError('Not enough components at this location to issue the order.', 'short', list);
  }
  if (msg.startsWith('INSUFFICIENT_STOCK:')) return new AppError(msg.replace('INSUFFICIENT_STOCK:', 'Not enough stock:').trim(), 'stock');
  if (/JWT|not signed in/i.test(msg)) return new AppError('Your session expired — please sign in again.', 'auth');
  if (/permission denied|row-level security/i.test(msg)) return new AppError('Your role does not have permission for that. ' + msg.replace(/^.*?:\s*/, ''), 'perm');
  if (/Failed to fetch|NetworkError/i.test(msg)) return new AppError('Cannot reach the database. Check your internet connection and config.js.', 'net');
  return new AppError(msg, 'error');
}

export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw friendly(error);
  return data;
}
export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw friendly(error);
  return data;
}

// ---- cached reference data (refreshed by realtime when items change) ----
let itemsCache = null, locCache = null, reasonCache = null, settingsCache = null;
export async function getItems(force = false) {
  if (!itemsCache || force) {
    itemsCache = await q(sb.from('items').select('id, sku, name, item_type, category, scent_family, scent_notes, description, uom, barcode, std_cost, avg_cost, price, lead_time_days, preferred_supplier_id, ordering_policy, batch_size, color_hex, accent_hex, active, reorder_point_override').order('sku'));
  }
  return itemsCache;
}
export function invalidateItems() { itemsCache = null; }
export async function getLocations() {
  if (!locCache) locCache = await q(sb.from('locations').select('*').order('sort'));
  return locCache;
}
export async function getReasons(category) {
  if (!reasonCache) reasonCache = await q(sb.from('reason_codes').select('*').order('code'));
  return category ? reasonCache.filter(r => r.category === category) : reasonCache;
}
export async function getSettings(force = false) {
  if (!settingsCache || force) settingsCache = await q(sb.from('settings').select('*').eq('id', 1).single());
  return settingsCache;
}
export function invalidateSettings() { settingsCache = null; }

// Resolve a scanned / typed code to an item (barcode or SKU, case-insensitive)
export async function findItem(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const items = await getItems();
  return items.find(i => i.barcode.toUpperCase() === c || i.sku.toUpperCase() === c) || null;
}
