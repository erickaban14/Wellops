// App shell: login, launcher, navigation, routing and the menu definition of every module.
import { api, can, h, invalidate, oops, state, svg, toast } from './core.js';
import { formView, listView } from './views.js';
import { dashboardPage } from './pages/dashboard.js';
import * as planning from './pages/planning.js';
import * as operations from './pages/operations.js';
import * as hr from './pages/hr.js';
import * as inventory from './pages/inventory.js';
import * as misc from './pages/misc.js';
import { flushQueue, initOffline, queued } from './offline.js';

const post = (path, body = {}) => api(path, { body });
const put = (table, id, body) => api(`/data/${table}/${id}`, { method: 'PUT', body });
const mine = r => r.employee_id === state.user.employee_id;

const ICON = {
  dashboard: '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/>',
  sales: '<path d="M4 19V9m5 10V5m5 14v-7m5 7V8"/>',
  planning: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4M7 14h5m-5 3h9"/>',
  operations: '<path d="M12 3 6 21m6-18 6 18M8 15h8M9.5 10h5M4 21h16"/>',
  assets: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/>',
  procurement: '<path d="M4 5h2l2.2 10h9.6L20 8H7.2"/><circle cx="9.5" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  inventory: '<path d="m3 8 9-5 9 5v8l-9 5-9-5V8Zm0 0 9 5m0 0 9-5m-9 5v8"/>',
  hr: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.5-3.5 3-5.5 6-5.5s5.500 2 6 5.500M16 5.200a3 3 0 0 1 0 5.600M17.500 14.800c2 .6 3.200 2.400 3.500 5.200"/>',
  finance: '<circle cx="12" cy="12" r="9"/><path d="M14.800 9c-.5-1-1.500-1.500-2.800-1.500-1.700 0-2.800.9-2.800 2.200 0 3 5.800 1.500 5.800 4.500 0 1.300-1.200 2.300-3 2.300-1.400 0-2.500-.6-3-1.700M12 5.500v2m0 9v2"/>',
  self: '<circle cx="12" cy="8" r="3.600"/><path d="M5 20c.6-3.800 3.400-6 7-6s6.400 2.200 7 6"/>',
  settings: '<path d="M4 7h10m4 0h2M4 17h4m4 0h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};

// ---------- Module menus. {table} = generic list/form, {page} = custom page ----------
const APPS = [
  { key: 'sales', label: 'Sales', color: '#c9603c', menus: [
    { key: 'sales_orders', label: 'Orders', table: 'sales_orders', cols: ['so_no', 'customer_id', 'well_id', 'operation', 'requested_start', 'amount', 'status'],
      defaults: () => ({ status: 'quotation' }), actions: [
        { label: 'Confirm order', primary: true, show: r => r.status === 'quotation', run: r => put('sales_orders', r.id, { status: 'confirmed' }).then(() => 'Order confirmed. It is now available to Planning.') },
        { label: 'Create invoice', show: r => ['planned', 'in progress', 'done'].includes(r.status) && can('finance'), run: r => post('/data/invoices', { customer_id: r.customer_id, so_id: r.id, amount: r.amount, status: 'draft' }).then(() => 'Draft invoice created in Finance') }] },
    { key: 'customers', label: 'Customers', table: 'customers' },
    { key: 'wells', label: 'Wells', table: 'wells' }] },

  { key: 'planning', label: 'Planning', color: '#3b7dc4', menus: [
    { key: 'select', label: 'Machine Selection', page: planning.machineSelection },
    { key: 'mps', label: 'Master Schedule', table: 'mps_lines', cols: ['well_id', 'operation', 'api_code', 'depth_ft', 'flow_gpm', 'start_date', 'machine_id', 'status'], sort: (a, b) => a.start_date.localeCompare(b.start_date),
      intro: 'Demand from confirmed sales orders. Firm the lines you want to plan, then run MRP.', defaults: () => ({ status: 'draft' }),
      toolbar: [{ label: 'Pull confirmed orders', show: () => can('planning'), run: () => post('/planning/mps/generate').then(r => `${r.created} line(s) added to the master schedule`) }],
      actions: [{ label: 'Firm', primary: true, show: r => r.status === 'draft', run: r => put('mps_lines', r.id, { status: 'firmed' }).then(() => 'Line firmed - ready for MRP') },
        { label: 'Back to draft', show: r => r.status === 'firmed', run: r => put('mps_lines', r.id, { status: 'draft' }) }] },
    { key: 'mrp', label: 'MRP', page: planning.mrpPage },
    { key: 'availability', label: 'Availability', page: planning.availabilityPage },
    { key: 'documents', label: 'Manuals', table: 'documents', extra: misc.documentFile },
    { key: 'api_standards', label: 'API Standards', table: 'api_standards' },
    { key: 'activity_templates', label: 'Activities', table: 'activity_templates', sort: (a, b) => a.operation.localeCompare(b.operation) || a.seq - b.seq },
    { key: 'material_templates', label: 'Materials', table: 'material_templates' },
    { key: 'crew_templates', label: 'Crew', table: 'crew_templates' },
    { key: 'kpi_templates', label: 'KPI Targets', table: 'kpi_templates' }] },

  { key: 'operations', label: 'Operations', color: '#1d6f84', menus: [
    { key: 'projects', label: 'Projects', table: 'projects', cols: ['code', 'name', 'operation', 'machine_id', 'start_date', 'end_date', 'budget', 'status'], create: false, detail: operations.projectPage },
    { key: 'work_tickets', label: 'Daily Work Tickets', page: operations.ticketsPage },
    { key: 'work_limit_alerts', label: 'Work-limit Alerts', table: 'work_limit_alerts', create: false, readonly: true, actions: [
      { label: 'Approve extension', primary: true, show: r => r.status === 'pending', run: r => post(`/operations/alerts/${r.id}/decide`, { approve: true }).then(() => 'Approved') },
      { label: 'Reject', danger: true, show: r => r.status === 'pending', run: r => post(`/operations/alerts/${r.id}/decide`, { approve: false }).then(() => 'Rejected') }] },
    { key: 'project_costs', label: 'Costs', table: 'project_costs', cols: ['project_id', 'cost_date', 'category', 'description', 'ref', 'amount'], newest: true },
    { key: 'wells', label: 'Wells', table: 'wells' }] },

  { key: 'assets', label: 'Machines', color: '#6d5aa8', menus: [
    { key: 'machines', label: 'Machines', table: 'machines', cols: ['code', 'name', 'operation', 'api_code', 'max_depth_ft', 'max_flow_gpm', 'day_rate', 'status'] },
    { key: 'maintenance_plans', label: 'Preventive Maintenance', table: 'maintenance_plans', defaults: () => ({ status: 'scheduled', pm_type: 'preventive' }) },
    { key: 'documents', label: 'Manuals', table: 'documents', extra: misc.documentFile }] },

  { key: 'procurement', label: 'Procurement', color: '#b5762a', menus: [
    { key: 'requisitions', label: 'Requisitions', table: 'requisitions', cols: ['description', 'qty', 'need_date', 'order_by', 'project_id', 'reason', 'status'], defaults: () => ({ status: 'open', reason: 'manual' }) },
    { key: 'rfqs', label: 'RFQs', table: 'rfqs', cols: ['rfq_no', 'supplier_id', 'rfq_date', 'due_date', 'mrp_run_id', 'status'], defaults: () => ({ status: 'draft' }), actions: [
      { label: 'Mark as sent', show: r => r.status === 'draft', run: r => put('rfqs', r.id, { status: 'sent' }) },
      { label: 'Convert to PO', primary: true, show: r => ['draft', 'sent', 'quoted'].includes(r.status), run: r => post(`/procurement/rfq/${r.id}/convert`).then(po => { r._po = po.id; return `${po.po_no} created`; }), goto: r => `#/procurement/purchase_orders/${r._po}` }] },
    { key: 'purchase_orders', label: 'Purchase Orders', table: 'purchase_orders', cols: ['po_no', 'supplier_id', 'order_date', 'expected_date', 'total', 'current_approver', 'status'],
      locked: r => r.id && !['draft', 'rejected'].includes(r.status) && `This PO is ${r.status} and can no longer be edited.`, extra: misc.poApprovals, actions: [
        { label: 'Submit for approval', primary: true, show: r => ['draft', 'rejected'].includes(r.status), run: r => post(`/procurement/po/${r.id}/submit`).then(p => (p.status === 'approved' ? 'Approved (no approval rule applies)' : `Sent to ${p.current_approver} for approval`)) },
        { label: 'Approve', primary: true, show: r => r.status === 'pending approval' && [r.current_approver, 'admin'].includes(state.user.role), run: r => post(`/procurement/po/${r.id}/decide`, { approve: true }).then(() => 'Approved') },
        { label: 'Reject', danger: true, show: r => r.status === 'pending approval' && [r.current_approver, 'admin'].includes(state.user.role), run: r => post(`/procurement/po/${r.id}/decide`, { approve: false }).then(() => 'Rejected') }] },
    { key: 'suppliers', label: 'Suppliers', table: 'suppliers' },
    { key: 'items', label: 'Item Master', table: 'items', cols: ['code', 'name', 'category', 'uom', 'unit_cost', 'lead_time_days', 'reorder_level', 'reorder_qty'] },
    { key: 'approval_rules', label: 'Approval Rules', table: 'approval_rules', sort: (a, b) => a.seq - b.seq, intro: 'A PO needs approval from every role whose threshold its total reaches, in sequence.' }] },

  { key: 'inventory', label: 'Inventory', color: '#2f8f6b', menus: [
    { key: 'items', label: 'Stock', table: 'items', cols: ['code', 'name', 'category', 'location', 'on_hand', 'uom', 'reorder_level', 'safety_stock'] },
    { key: 'receive', label: 'Receive', page: inventory.receivePage },
    { key: 'qa', label: 'QA', page: inventory.qaPage },
    { key: 'issue', label: 'Issue / Return / Adjust', page: inventory.transactionsPage },
    { key: 'counts', label: 'Physical Inventory', page: inventory.countsPage },
    { key: 'stock_moves', label: 'Stock Moves', table: 'stock_moves', cols: ['move_date', 'move_type', 'item_id', 'qty', 'ref', 'project_id', 'qa_status', 'done_by'], create: false, readonly: true, newest: true },
    { key: 'qa_inspections', label: 'QA History', table: 'qa_inspections', create: false, readonly: true, newest: true }] },

  { key: 'hr', label: 'Human Resources', color: '#b0477a', menus: [
    { key: 'employees', label: 'Employees', table: 'employees', cols: ['emp_no', 'name', 'position', 'department', 'accumulated_hours', 'accumulated_days', 'status'], defaults: () => ({ status: 'active' }) },
    { key: 'compliance', label: 'Training Matrix', page: hr.compliancePage },
    { key: 'training_schedules', label: 'Training Schedule', table: 'training_schedules', cols: ['employee_id', 'course_id', 'start_date', 'end_date', 'source', 'note', 'status'], sort: (a, b) => String(a.start_date).localeCompare(b.start_date),
      defaults: () => ({ status: 'planned', source: 'manual' }), toolbar: [{ label: 'Generate from MRP', show: () => can('hr'), run: hr.generateFromMrp }],
      actions: [{ label: 'Confirm', primary: true, show: r => r.status === 'planned', run: r => put('training_schedules', r.id, { status: 'confirmed' }) },
        { label: 'Mark completed', show: r => r.status === 'confirmed', run: hr.completeTraining }] },
    { key: 'training_courses', label: 'Courses', table: 'training_courses', cols: ['code', 'name', 'pillar', 'standard', 'duration_days', 'validity_months'] },
    { key: 'training_matrix', label: 'Matrix Setup', table: 'training_matrix' },
    { key: 'training_records', label: 'Certificates', table: 'training_records' },
    { key: 'leaves', label: 'Leaves', table: 'leaves', cols: ['employee_id', 'leave_type', 'start_date', 'end_date', 'paid', 'status'], actions: [
      { label: 'Approve', primary: true, show: r => r.status === 'requested', run: r => put('leaves', r.id, { status: 'approved' }) },
      { label: 'Reject', danger: true, show: r => r.status === 'requested', run: r => put('leaves', r.id, { status: 'rejected' }) }] },
    { key: 'timekeeping', label: 'Timekeeping', page: hr.timekeepingPage },
    { key: 'timesheets', label: 'Timesheets', table: 'timesheets', cols: ['employee_id', 'project_id', 'work_date', 'regular_hours', 'ot_hours', 'source', 'status'], defaults: () => ({ source: 'manual', status: 'captured' }), newest: true },
    { key: 'payroll', label: 'Payroll', page: hr.payrollPage }] },

  { key: 'finance', label: 'Finance', color: '#4a6572', menus: [
    { key: 'invoices', label: 'Receivables', table: 'invoices', defaults: () => ({ status: 'draft' }), locked: r => r.status === 'paid' && 'Paid invoices are locked.', actions: [
      { label: 'Post', primary: true, show: r => r.status === 'draft', run: r => post(`/finance/invoices/${r.id}/post`).then(() => 'Invoice posted to the ledger') },
      { label: 'Register payment', primary: true, show: r => r.status === 'posted', run: r => post(`/finance/invoices/${r.id}/pay`).then(() => 'Payment registered') }] },
    { key: 'bills', label: 'Payables', table: 'bills', defaults: () => ({ status: 'draft' }), actions: [
      { label: 'Post', primary: true, show: r => r.status === 'draft', run: r => put('bills', r.id, { status: 'posted' }) },
      { label: 'Register payment', primary: true, show: r => r.status === 'posted', run: r => post(`/finance/bills/${r.id}/pay`).then(() => 'Payment registered') }] },
    { key: 'project_costs', label: 'Project Costs', page: misc.projectCostsPage },
    { key: 'journal_entries', label: 'Journal', table: 'journal_entries', cols: ['entry_date', 'ref', 'memo', 'account_id', 'debit', 'credit', 'project_id'], newest: true },
    { key: 'trial_balance', label: 'Trial Balance', page: misc.trialBalancePage },
    { key: 'accounts', label: 'Chart of Accounts', table: 'accounts', sort: (a, b) => a.code.localeCompare(b.code) }] },

  { key: 'self', label: 'My Space', color: '#58708a', menus: [
    { key: 'my_timesheets', label: 'My Timesheets', table: 'timesheets', cols: ['work_date', 'project_id', 'regular_hours', 'ot_hours', 'status'], filter: mine, create: false, readonly: true, newest: true },
    { key: 'my_trainings', label: 'My Trainings', table: 'training_schedules', cols: ['course_id', 'start_date', 'end_date', 'status', 'note'], filter: mine, create: false, readonly: true },
    { key: 'my_leaves', label: 'My Leaves', table: 'leaves', cols: ['leave_type', 'start_date', 'end_date', 'status', 'remarks'], filter: mine, mine: true, lockFields: ['status', 'paid'],
      defaults: () => ({ employee_id: state.user.employee_id }), locked: r => r.id && r.status !== 'requested' && `This request was ${r.status}.` },
    { key: 'my_payslips', label: 'My Payslips', table: 'payslips', cols: ['run_id', 'days_worked', 'regular_hours', 'ot_hours', 'gross_pay', 'deductions', 'net_pay'], filter: mine, create: false, readonly: true },
    { key: 'profile', label: 'Profile & Face Login', page: misc.profilePage }] },

  { key: 'settings', label: 'Settings', color: '#59636b', menus: [
    { key: 'users', label: 'Users', table: 'users', cols: ['name', 'email', 'role', 'employee_id', 'active'] },
    { key: 'settings', label: 'Parameters', table: 'settings', cols: ['key', 'value', 'description'], intro: 'System parameters, including the maximum consecutive working days (max_work_days).' },
    { key: 'sync', label: 'Data Sync', page: misc.syncPage }] },
];
const myApps = () => APPS.filter(a => can(a.key));
export const canOpen = link => !!link && can(link.split('/')[0]);

// ---------- Shell ----------
const root = document.getElementById('app');
const initials = n => String(n || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
let content, pendingBadge;

function shell(app, menuKey) {
  const menus = h('div.menus', app ? app.menus.map(m => h('a', { href: `#/${app.key}/${m.key}`, class: m.key === menuKey ? 'on' : '' }, m.label)) : null);
  let drop;
  const userMenu = e => {
    e.stopPropagation();
    if (drop) { drop.remove(); drop = null; return; }
    drop = h('div.dropdown', h('div.who', h('strong', state.user.name), h('div.muted', state.user.role_label), h('div.muted', { style: { fontSize: '12px' } }, `Database: ${state.mode}`)),
      can('self') ? h('a', { href: '#/self/profile' }, 'Profile & face login') : null,
      h('button', { onclick: async () => { await api('/logout', { method: 'POST' }).catch(() => {}); localStorage.removeItem('wo_me'); location.hash = ''; location.reload(); } }, 'Sign out'));
    document.body.append(drop);
    document.addEventListener('click', () => { drop?.remove(); drop = null; }, { once: true });
  };
  pendingBadge = h('span.pill', { hidden: true });
  content = h('main');
  root.replaceChildren(
    h('nav.nav', h('a.brand', { href: '#/', title: 'All apps', 'aria-label': 'All apps' }, svg('<path d="M5 5h3v3H5zM10.500 5h3v3h-3zM16 5h3v3h-3zM5 10.500h3v3H5zM10.500 10.500h3v3h-3zM16 10.500h3v3h-3zM5 16h3v3H5zM10.500 16h3v3h-3zM16 16h3v3h-3z"/>'), h('span', app ? app.label : state.company)),
      app ? h('button.menu-toggle', { 'aria-label': 'Menu', onclick: () => menus.classList.toggle('open') }, svg('<path d="M4 7h16M4 12h16M4 17h16"/>')) : null, menus,
      h('div.tools', h('a', { href: '#/dashboard', title: 'Dashboard', 'aria-label': 'Dashboard' }, svg(ICON.dashboard)),
        h('button', { title: 'Offline work tickets waiting to sync', onclick: () => flushQueue(true) }, h('span.net', { id: 'net', class: state.offline ? 'off' : '' }, state.offline ? 'Offline' : 'Online'), pendingBadge),
        h('button', { onclick: userMenu, 'aria-label': 'User menu' }, h('span.avatar', initials(state.user.name))))),
    content);
  menus.addEventListener('click', () => menus.classList.remove('open'));
  updateNet();
}
export function updateNet() {
  const n = queued().length, net = document.getElementById('net');
  if (pendingBadge) { pendingBadge.hidden = !n; pendingBadge.textContent = `${n} to sync`; }
  if (net) { net.className = `net${state.offline ? ' off' : ''}`; net.textContent = state.offline ? 'Offline' : 'Online'; }
}

function home() {
  shell();
  const tile = (key, label, color, href) => h('a.app-tile', { href }, h('span.ico', { style: { background: color } }, svg(ICON[key])), label);
  content.replaceChildren(h('div.hello', h('h1', `Welcome, ${state.user.name.split(' ')[0]}`), h('div.muted', `${state.user.role_label} · ${state.company}`)),
    h('div.home', tile('dashboard', 'Dashboard', '#1d4e5f', '#/dashboard'), myApps().map(a => tile(a.key, a.label, a.color, `#/${a.key}/${a.menus[0].key}`))));
}

let renderSeq = 0;
async function render() {
  if (!state.user) return misc.loginPage(root, boot);
  const seq = ++renderSeq;
  const [appKey, menuKey, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (!appKey || appKey === 'login') return home();
  if (appKey === 'dashboard') { shell(); return run(seq, () => dashboardPage(content, canOpen)); }
  const app = myApps().find(a => a.key === appKey);
  if (!app) { location.hash = '#/'; return; }
  const menu = app.menus.find(m => m.key === menuKey) || app.menus[0];
  shell(app, menu.key);
  const base = `#/${app.key}/${menu.key}`;
  if (state.offline && menu.key !== 'work_tickets') return content.replaceChildren(h('div.banner.warn', 'You are offline. Daily Work Tickets remain available; other screens need a connection.'),
    can('operations') ? h('a.btn.primary', { href: '#/operations/work_tickets' }, 'Open Daily Work Tickets') : null);
  run(seq, () => (menu.page ? menu.page(content, id, base) : id && menu.detail ? menu.detail(content, id, base) : id ? formView(content, menu, id, base) : listView(content, menu, base)));
}
async function run(seq, fn) {
  content.replaceChildren(h('div.empty', 'Loading…'));
  try { await fn(); } catch (e) { if (seq === renderSeq) content.replaceChildren(h('div.banner.bad', e.message)); }
}

// ---------- Boot ----------
async function boot() {
  try {
    const me = await api('/me');
    Object.assign(state, { user: me.user, meta: me.meta, company: me.company, mode: me.mode, sync_configured: me.sync_configured, offline: false });
    localStorage.setItem('wo_me', JSON.stringify(me));
  } catch (e) {
    const saved = e.offline && JSON.parse(localStorage.getItem('wo_me') || 'null');
    if (saved) Object.assign(state, { user: saved.user, meta: saved.meta, company: saved.company, mode: saved.mode, offline: true });   // offline start: last signed-in user on this device
    else state.user = null;
  }
  document.title = state.company;
  if (state.user) { initOffline(() => { updateNet(); if (location.hash.includes('work_tickets')) render(); }); listen(); if (state.offline && can('operations')) location.hash = '#/operations/work_tickets'; }
  render();
}

// Live updates: the server tells us which tables changed; refresh caches and the dashboard / project screens.
let es, refreshTimer;
function listen() {
  if (es || state.offline) return;
  es = new EventSource('/api/events');
  es.onmessage = ev => {
    invalidate(JSON.parse(ev.data));
    if (/^#\/(dashboard|operations\/projects\/)/.test(location.hash)) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => !document.querySelector('.overlay') && render(), 1200); }
  };
}
window.addEventListener('hashchange', render);
window.addEventListener('online', () => { if (state.offline) boot(); });
window.addEventListener('offline', () => { state.offline = true; updateNet(); });
window.addEventListener('unhandledrejection', e => oops(e.reason || new Error('Unexpected error')));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
export { render, toast };
