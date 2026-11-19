// Single source of truth for pages and who may open them (used by the router, the sidebar and every in-page link).
const STAFF = ['manager', 'cashier', 'production'];
export const ROUTES = [
  { grp: 'Operations' },
  { path: 'dashboard', title: 'Dashboard', ic: '◎', roles: STAFF, mod: './pages/dashboard.js' },
  { path: 'pos', title: 'Point of Sale', ic: '🛒', roles: ['manager', 'cashier'], mod: './pages/pos.js' },
  { path: 'orders', title: 'Sales Orders', ic: '📦', roles: ['manager', 'cashier'], mod: './pages/orders.js', pill: 'open_pickups' },
  { path: 'returns', title: 'Returns & Exchanges', ic: '↺', roles: ['manager', 'cashier'], mod: './pages/returns.js' },
  { grp: 'Inventory' },
  { path: 'inventory', title: 'Inventory', ic: '▦', roles: STAFF, mod: './pages/inventory.js' },
  { path: 'items', title: 'Items & BOMs', ic: '🧾', roles: STAFF, mod: './pages/items.js' },
  { path: 'labels', title: 'Barcode Labels', ic: '▥', roles: STAFF, mod: './pages/labels.js' },
  { grp: 'Make & Buy' },
  { path: 'production', title: 'Production', ic: '🕯️', roles: ['manager', 'production'], mod: './pages/production.js' },
  { path: 'purchasing', title: 'Purchasing', ic: '🚚', roles: ['manager', 'production'], mod: './pages/purchasing.js' },
  { path: 'suppliers', title: 'Suppliers & Scorecard', ic: '★', roles: ['manager'], mod: './pages/suppliers.js' },
  { grp: 'Planning' },
  { path: 'reorder', title: 'Reorder Review', ic: '⟳', roles: ['manager', 'production'], mod: './pages/reorder.js' },
  { path: 'mrp', title: 'MRP', ic: '⧉', roles: ['manager', 'production'], mod: './pages/mrp.js' },
  { path: 'planner', title: 'Holiday Planner', ic: '❄', roles: ['manager', 'production'], mod: './pages/planner.js' },
  { grp: 'Insights' },
  { path: 'financials', title: 'Financials', ic: '$', roles: ['manager'], mod: './pages/financials.js' },
  { path: 'reports', title: 'Reports', ic: '📈', roles: ['manager'], mod: './pages/reports.js' },
  { grp: 'Shop' },
  { path: 'shop', title: 'Shop Emblet', ic: '🌲', roles: ['customer'], mod: './pages/shop.js' },
  { path: 'myorders', title: 'My Orders', ic: '📦', roles: ['customer'], mod: './pages/myorders.js' },
  { grp: 'System' },
  { path: 'settings', title: 'Settings', ic: '⚙', roles: ['manager'], mod: './pages/settings.js' },
  { path: 'about', title: 'About this System', ic: 'ⓘ', roles: [...STAFF, 'customer'], mod: './pages/about.js' },
];
export const HOME = { admin: 'dashboard', manager: 'dashboard', cashier: 'pos', production: 'production', customer: 'shop' };
export const can = (r, role) => !!r && (role === 'admin' ? r.roles.some(x => x !== 'customer') : r.roles.includes(role));

let currentRole = null;
export function setRole(role) { currentRole = role; }
/** may the signed-in user open this hash link? ('#/orders?tab=back' or 'orders') */
export function allowed(href) {
  const path = String(href).replace(/^#\/?/, '').split('?')[0];
  return can(ROUTES.find(x => x.path === path), currentRole);
}
/** an href only when the viewer can follow it — otherwise undefined (renders plain, unclickable) */
export const hrefIf = href => allowed(href) ? href : undefined;
