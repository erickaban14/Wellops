# ProStars ERP

ERP for oil-services contractors running wells, rigs and pumps. Node.js application server, Supabase database, optional
on-premise PostgreSQL mirror, responsive browser UI (desktop, tablet, phone) with offline Daily Work Tickets.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. With no `.env` the app runs in **demo mode**: data lives in `data/db.json`, demo data is loaded
on first start, and the login page offers a role picker so you can open the system as any of the 32 role profiles.
Delete `data/db.json` to reset the demo.

## Connect Supabase (production database)

1. Create a Supabase project.
2. Open the SQL editor and run `supabase/schema.sql` (regenerate any time with `npm run schema`; it is safe to re-run).
3. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project settings › API).
4. Set `DEMO_LOGIN=false`, a long random `SESSION_SECRET` and your own `SEED_PASSWORD`, then `npm start`.

On first start against an empty database the same demo data is loaded; users are `<role>@wellops.test`
(for example `rig.manager@wellops.test`) with the `SEED_PASSWORD`. Tables have row-level security enabled with no
policies, so only the Node server (service-role key) can reach the data. Manuals are stored in the private `manuals`
storage bucket and served through short-lived signed URLs.

## Synchronise to on-premise PostgreSQL

Set `ONPREM_PG_URL=postgres://user:password@host:5432/database` in `.env`. Then either:

- **Settings › Data Sync › Sync now** (administrator),
- `npm run sync` from a scheduler, or
- `SYNC_INTERVAL_MIN=15` for automatic sync every 15 minutes.

The sync is one-way (Supabase → on-prem): it creates/upgrades the tables, upserts rows changed since the last successful
run and removes rows deleted upstream. Every run is logged in Sync history.

## Modules

| App | What it does |
| --- | --- |
| Dashboard | Widgets adapt to the signed-in role (`server/roles.js`). Live refresh through server-sent events. |
| Sales | Customers, wells, quotations/orders. Confirmed orders feed the master schedule. |
| Planning | Machine selection by API code, depth, flow rate and operation; master schedule (MPS); MRP run producing activities with day/hour timelines, materials, manning, machine and accessory tools, KPIs; availability board; manuals repository; templates. |
| Operations | Projects with planned-vs-actual progress, exceptions, KPIs and accumulated cost; Daily Work Tickets (online and offline); work-day limit approvals. |
| Machines | Fleet register, API ratings, preventive maintenance plans. |
| Procurement | Item master (lead time, reorder level/quantity, safety stock, minimum order), requisitions, RFQs, purchase orders with approval routing by amount. |
| Inventory | Receiving against POs, QA inspection, issues, returns, adjustments, physical inventory with variance posting. |
| Human Resources | Employees, 4-pillar training matrix and compliance grid, training schedules generated from firmed MRP runs, leaves, timekeeping, payroll. |
| Finance | Receivables, payables, journal, trial balance, project cost report. |
| My Space | Own timesheets, trainings, leave requests, payslips, face enrolment. |

### The planning-to-payroll flow

1. Sales confirms an order → Planning **Pull confirmed orders** into the Master Schedule and **Firm** the lines.
2. **Run MPS / MRP** → review the plan (machine chosen around PM plans and deployments, crew checked against leaves,
   trainings and other projects, material shortages with order-by dates) → **Approve** → **Firm**.
3. Firming creates the projects and automatically raises purchase requisitions, RFQs (one per preferred supplier) and
   training schedules for crew whose certificates are missing or expire before the job ends.
4. Procurement converts RFQs to POs → approval routing → warehouse receives → QA → stock.
5. Field crews enter Daily Work Tickets. Submitting a ticket posts timesheets, material consumption, machine day rate
   and labour cost to the project, and updates planned-vs-actual progress on the Rig Manager dashboard.
6. Anyone exceeding the maximum consecutive working days (`max_work_days`, default 15, in Settings › Parameters)
   raises an approval for the Rig Manager.
7. Timekeeping consolidates timesheets (real time for online tickets, on demand for offline ones) → Payroll calculates
   pay from worked hours, overtime, paid leave and allowances.

## Offline and field use

- The app installs as a PWA; the shell is cached by a service worker.
- Open **Daily Work Tickets** once while online on each device. After that, tickets can be entered with no connection:
  they are stored on the device, shown under "Waiting to sync", and pushed automatically when the connection returns.
- **Face login**: enrol under My Space › Profile, then use "Sign in with face recognition". Only a numeric face
  signature is stored. The recognition library and models load from jsDelivr, so the first use needs internet;
  cameras require HTTPS (or localhost).
- **VPN**: a browser cannot start a VPN by itself. After a successful face login the app opens the URL in
  `vpn_connect_url` (Settings › Parameters or `VPN_CONNECT_URL`), which should be your VPN client's connect link
  or a local agent endpoint on the device.

## Interface notes

- **Phones**: primary actions sit in a bar fixed to the bottom of the screen; lists collapse to compact cards; controls are at least 44 px on touch devices.
- **Work tickets** keep every change on the device as you type, so an interrupted entry can be continued later.
- **Logo**: `public/icon.svg` is the only logo file. Replacing it updates the login page, the top bar, the browser tab icon and the installed-app icon. The company name in the top bar comes from Settings › Parameters › `company_name`.
- **Theme**: Auto / Light / Dark in the user menu (top right).
- **Lists**: click a column header to sort, filter by status chips, page through 50 at a time, Export downloads the filtered rows as CSV.
- **Forms** warn before discarding unsaved changes and show validation messages next to the field.
- **Approvals and postings** ask for confirmation; rejections require a reason, which is stored.
- **Passwords**: users change their own under My Space › Profile; an administrator resets forgotten ones under Settings › Users (there is no e-mail reset).
- **Currency and time**: amounts show the `currency` parameter (default USD); date-times are shown in site time as stored (UTC wall-clock).

## Project layout

```
server/models.js        data model: drives SQL schema, REST API and screens
server/roles.js         role profiles: app access + dashboard widgets
server/services/        planning (MRP), operations, hr, procurement, inventory, dashboard
server/store/           Supabase driver and local demo driver
server/sync/pgsync.js   on-premise PostgreSQL mirror
supabase/schema.sql     generated schema for the Supabase SQL editor
public/                 browser app (no build step)
```

To add a field or table, edit `server/models.js`, run `npm run schema`, and apply the SQL in Supabase.
