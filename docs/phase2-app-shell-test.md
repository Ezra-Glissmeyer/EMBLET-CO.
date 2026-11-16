# Phase 2 test script — login, navigation, Supabase client, Realtime, Settings, About

Use the live site: `https://ezra-glissmeyer.github.io/EMBLET-CO./`. Keep **Supabase → Table Editor** open in another tab to watch rows change. Passwords are in the README.

You need **two browser windows**: a normal window plus a private/incognito window (or your phone). Each one holds its own login.

---

### 1. Login & errors
1. Open the site. **Expect:** the green Emblet login page. The demo buttons fill in the email only; no passwords are shown on the page.
2. Enter `manager@emblet.test` with the wrong password. **Expect:** "Email or password is incorrect." in red, and you stay on the login page.
3. Sign in with the right password. **Expect:** you land on `…/#/dashboard` with "Good morning/afternoon, Morgan". The sidebar shows the manager's name and a **MANAGER** badge.
4. Refresh the page (F5). **Expect:** you are still signed in, on the same page.

### 2. Role-based navigation
Sign out, then sign in as each role.

| Login | Lands on | Menu shows | Menu does **not** show |
|---|---|---|---|
| manager | Dashboard | everything incl. Financials, Reports, Settings | Shop, My Orders |
| cashier | Point of Sale | Dashboard, POS, Sales Orders, Returns, Inventory, Items, Labels, About | Production, Purchasing, MRP, Financials, Settings |
| production | Production | Dashboard, Inventory, Items, Labels, Production, Purchasing, Reorder, MRP, Planner, About | POS, Sales Orders, Financials, Settings |
| customer | Shop | Shop, My Orders, About | every staff page |
| admin | Dashboard | every staff page | Shop |

**Typing a forbidden address:** as the cashier, change the address to `…/#/financials` and press Enter. **Expect:** you are bounced back to `#/pos`. Do the same as the customer with `#/dashboard`; **expect** to be bounced to `#/shop`.

**The database enforces this too, not just the menu.** This tries to set the sales tax to 0% while signed in as the cashier, going around the menus and talking straight to the database:
1. Signed in as the **cashier** on the live site, press **F12** (Mac: Cmd+Option+J) and click the **Console** tab.
2. If Chrome warns about pasting, type `allow pasting` and press Enter first.
3. Paste this and press Enter:
```js
const m = await import('./js/lib/db.js'); (await m.sb.from('settings').update({ sales_tax_rate: 0 }).eq('id', 1).select()).data
```
4. **Where to look:** the answer prints on the next line in the Console. **Expect `[]`**, an empty list, meaning *zero rows were changed*: the database refused. If you see a row instead, that would be a problem; tell me.
5. Confirm in Supabase: **Table Editor → `settings`** (the table has one row) → the `sales_tax_rate` column still shows **0.0725**.
6. Optional contrast: sign in as the **manager** and run the same line with `0.0725` instead of `0`. It prints `[ {…} ]` (one row), because managers *are* allowed.

### 3. Settings page (manager) — rows change
1. Table Editor → `settings`: note `sales_tax_rate` (0.0725), `ordering_cost` (45.00) and `updated_at`.
2. As the manager, open **Settings**. Change **Sales tax rate (%)** to `7.45` and **Ordering cost** to `60`, then click **Save settings**.
   **Expect:** a green toast "Settings saved…", and "Last saved" at the top changes to now.
3. Refresh the Table Editor. **Expect:** the same single row now shows `sales_tax_rate = 0.0745`, `ordering_cost = 60.00`, and a new `updated_at`.
4. **It drives the math:** open **Point of Sale** and add one Ezra's Embers ($24). **Expect:** tax shows **$1.79** (7.45%) instead of $1.74. Then open **Reorder Review**: every EOQ is about **15% higher** (√(60/45) ≈ 1.15).
5. **Validation:** set the tax to `40` and save. **Expect:** a red toast "Sales tax must be between 0% and 25%." In Table Editor the row is **unchanged**.
6. Put the values back (`7.25` and `45`) and save.

### 4. Realtime (two windows)
1. Window A: **manager** on **Settings**. Window B (incognito or phone): **admin**, also on **Settings**.
2. In window B, change **Review period (days)** from 7 to `14` and save.
   **Expect:** within a couple of seconds, window A shows a blue toast "Settings were updated by another user" and the field now reads 14, with no refresh. Set it back to 7.
3. The top-right badge on both windows reads **● Live**. If it says "Realtime offline", refresh; if it stays offline, tell me.
4. Bonus, to see the whole loop: window A on **Dashboard**, window B as **cashier** on **POS**. Make a sale in B. **Expect:** A's "Today's net sales" goes up within about a second.

### 5. Admin: users & roles — rows change
1. Sign in as **admin**, then **Settings** → scroll to **Users & roles**.
   **Expect:** your own row says "admin (you)" with no dropdown, so you can't lock yourself out.
2. For `mia@emblet.test`, change the role from customer to **cashier** → **Change role**.
   **Expect:** a toast "mia@emblet.test is now cashier". In Table Editor → `profiles`, mia's `role` = `cashier`.
3. In the other window, sign in as `mia@emblet.test` (password `EmbletCustomer!1`). **Expect:** she now lands on the **POS** with the cashier menu.
4. Change mia back to **customer**.
5. As the **manager**, open Settings. **Expect:** no Users & roles section, because it's admin only.

### 6. About this System
Open **About** as any role. **Expect** these sections:
- AI tools used (Claude Code)
- Platform (Supabase Postgres / Auth / RLS / Realtime, GitHub Pages)
- Libraries with versions (supabase-js 2.57.4, Chart.js, JsBarcode, html5-qrcode)
- Core design rules
- The data-model table
- Key formulas

### 7. Sign out
Click **Sign out** (top-right of every page, and at the bottom of the sidebar). **Expect:** you return to the login page, and the address no longer has a `#/…` page in it. Sign in as a different role and you land on *that* role's home page.

---
**Pass:** every Expect above matches, especially the three database changes (the `settings` row in 3, `profiles.role` in 5) and the zero-rows result in section 2.
