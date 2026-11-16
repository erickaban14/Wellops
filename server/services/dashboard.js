// Role-adaptive dashboard. Each role profile (roles.js) lists widget ids; widgets are computed here on demand.
import { ROLES } from '../roles.js';
import { db } from '../store/index.js';
import { addDays, byId, groupBy, num, r2, sum, today } from '../util.js';
import { setting } from './common.js';
import { overview } from './operations.js';
import { timeSummary } from './hr.js';

const money = v => num(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const kpi = (title, value, link, tone = '', sub = '') => ({ type: 'kpi', title, value, link, tone, sub });
const list = (title, columns, rows, link, wide) => ({ type: 'list', title, columns, rows: rows.slice(0, 8), link, wide });
const live = s => !['completed', 'done', 'cancelled'].includes(s);

export async function dashboard(user) {
  const cache = {};
  const t = name => (cache[name] ||= db.list(name));
  const names = async (table, key = 'name') => { const m = byId(await t(table)); return id => m[id]?.[key] || ''; };
  let ovCache;
  const overviews = () => (ovCache ||= (async () => Promise.all((await t('projects')).filter(p => ['active', 'planned'].includes(p.status)).map(p => overview(p.id, t))))());
  const mine = async table => (await t(table)).filter(r => r.employee_id === user.employee_id);
  const lowStock = async () => (await t('items')).filter(i => num(i.reorder_level) > 0 && num(i.on_hand) <= num(i.reorder_level));
  const openDocs = async (table) => (await t(table)).filter(d => d.status === 'posted');
  const count = async (table, f) => (await t(table)).filter(f).length;
  const soon = addDays(today(), 30);

  const W = {
    // ---- KPI tiles ----
    k_active_projects: async () => kpi('Active projects', await count('projects', p => p.status === 'active'), 'operations/projects'),
    k_exceptions: async () => { const n = sum(await overviews(), o => o.exceptions.filter(e => e.level !== 'low').length); return kpi('Open exceptions', n, 'operations/projects', n ? 'bad' : 'good'); },
    k_work_alerts: async () => { const n = await count('work_limit_alerts', a => a.status === 'pending'); return kpi('Work-limit approvals', n, 'operations/work_limit_alerts', n ? 'warn' : 'good', `Limit ${await setting('max_work_days', 15)} days`); },
    k_cost_to_date: async () => kpi('Project cost to date', money(sum(await t('project_costs'), 'amount')), 'operations/project_costs'),
    k_tickets_today: async () => kpi('Work tickets today', await count('work_tickets', x => x.work_date === today()), 'operations/work_tickets'),
    k_tickets_draft: async () => kpi('Draft tickets', await count('work_tickets', x => x.status === 'draft'), 'operations/work_tickets', 'warn'),
    k_machines_avail: async () => kpi('Machines available', `${await count('machines', m => m.status === 'available')} / ${await count('machines', m => m.status !== 'retired')}`, 'assets/machines'),
    k_machines_maint: async () => kpi('In maintenance', await count('machines', m => m.status === 'maintenance'), 'assets/machines', 'warn'),
    k_pm_due: async () => kpi('PM due in 30 days', await count('maintenance_plans', p => p.status !== 'done' && p.start_date <= soon), 'assets/maintenance_plans', 'warn'),
    k_asset_value: async () => kpi('Asset register value', money(sum(await t('machines'), 'purchase_cost')), 'assets/machines'),
    k_mps_draft: async () => kpi('MPS lines to firm', await count('mps_lines', l => l.status === 'draft'), 'planning/mps'),
    k_mps_firmed: async () => kpi('Firmed, awaiting MRP', await count('mps_lines', l => l.status === 'firmed'), 'planning/mrp', 'warn'),
    k_mrp_pending: async () => kpi('MRP runs to approve/firm', await count('mrp_runs', r => r.status !== 'firmed'), 'planning/mrp', 'warn'),
    k_open_reqs: async () => kpi('Open requisitions', await count('requisitions', r => r.status === 'open'), 'procurement/requisitions'),
    k_open_rfqs: async () => kpi('Open RFQs', await count('rfqs', r => ['draft', 'sent', 'quoted'].includes(r.status)), 'procurement/rfqs'),
    k_po_pending: async () => { const n = await count('purchase_orders', p => p.status === 'pending approval'); return kpi('POs awaiting approval', n, 'procurement/purchase_orders', n ? 'warn' : 'good'); },
    k_po_open: async () => kpi('POs to receive', await count('purchase_orders', p => ['approved', 'partially received'].includes(p.status)), 'procurement/purchase_orders'),
    k_receipts_due: async () => kpi('POs to receive', await count('purchase_orders', p => ['approved', 'partially received'].includes(p.status)), 'inventory/receive'),
    k_low_stock: async () => { const n = (await lowStock()).length; return kpi('Items at reorder level', n, 'inventory/items', n ? 'bad' : 'good'); },
    k_pending_qa: async () => kpi('Awaiting QA', await count('stock_moves', m => m.qa_status === 'pending'), 'inventory/qa', 'warn'),
    k_stock_value: async () => kpi('Stock value', money(sum(await t('items'), i => num(i.on_hand) * num(i.unit_cost))), 'inventory/items'),
    k_counts_open: async () => kpi('Open stock counts', await count('stock_counts', c => c.status === 'draft'), 'inventory/counts'),
    k_open_quotes: async () => kpi('Open quotations', await count('sales_orders', o => o.status === 'quotation'), 'sales/sales_orders'),
    k_confirmed_orders: async () => kpi('Orders in progress', await count('sales_orders', o => ['confirmed', 'planned', 'in progress'].includes(o.status)), 'sales/sales_orders'),
    k_order_value: async () => kpi('Order book value', money(sum((await t('sales_orders')).filter(o => !['cancelled', 'quotation'].includes(o.status)), 'amount')), 'sales/sales_orders'),
    k_ar_open: async () => kpi('Receivables', money(sum(await openDocs('invoices'), 'amount')), 'finance/invoices'),
    k_ap_due: async () => kpi('Payables', money(sum(await openDocs('bills'), 'amount')), 'finance/bills'),
    k_inv_draft: async () => kpi('Draft invoices', await count('invoices', i => i.status === 'draft'), 'finance/invoices'),
    k_bills_draft: async () => kpi('Bills to post', await count('bills', i => i.status === 'draft'), 'finance/bills', 'warn'),
    k_headcount: async () => kpi('Active employees', await count('employees', e => e.status !== 'inactive'), 'hr/employees'),
    k_training_due: async () => kpi('Trainings scheduled', await count('training_schedules', s => ['planned', 'confirmed'].includes(s.status)), 'hr/training_schedules'),
    k_cert_expiring: async () => { const n = await count('training_records', r => r.expiry_date && r.expiry_date <= addDays(today(), 60)); return kpi('Certificates expiring (60d)', n, 'hr/compliance', n ? 'warn' : 'good'); },
    k_leave_requests: async () => kpi('Leave requests', await count('leaves', l => l.status === 'requested'), 'hr/leaves'),
    k_ts_unconsolidated: async () => { const n = await count('timesheets', x => x.status === 'captured'); return kpi('Timesheets to consolidate', n, 'hr/timekeeping', n ? 'warn' : 'good'); },
    k_ts_consolidated: async () => kpi('Consolidated, unpaid', await count('timesheets', x => x.status === 'consolidated'), 'hr/timekeeping'),
    k_payroll_draft: async () => kpi('Payroll runs in draft', await count('payroll_runs', r => r.status === 'draft'), 'hr/payroll'),
    k_my_hours: async () => kpi('My hours (30 days)', r2(sum((await mine('timesheets')).filter(x => x.work_date >= addDays(today(), -30)), x => num(x.regular_hours) + num(x.ot_hours))), 'self/my_timesheets'),
    k_my_days: async () => kpi('My days worked (30 days)', new Set((await mine('timesheets')).filter(x => x.work_date >= addDays(today(), -30)).map(x => x.work_date)).size, 'self/my_timesheets'),
    k_my_trainings: async () => kpi('My upcoming trainings', (await mine('training_schedules')).filter(s => ['planned', 'confirmed'].includes(s.status)).length, 'self/my_trainings'),
    k_my_leaves: async () => kpi('My leave requests', (await mine('leaves')).filter(l => l.status === 'requested').length, 'self/my_leaves'),

    // ---- Lists ----
    l_projects: async () => ({ type: 'projects', title: 'Project progress: planned vs actual', wide: true, rows: (await overviews()).map(o => ({ id: o.project.id, code: o.project.code, name: o.project.name, status: o.project.status,
      planned: o.planned_pct, actual: o.actual_pct, deviation: o.deviation, cost: o.cost, budget: o.budget, exceptions: o.exceptions.filter(e => e.level !== 'low').length })) }),
    l_exceptions: async () => ({ type: 'exceptions', title: 'Exceptions & deviations to date', rows: (await overviews()).flatMap(o => o.exceptions.map(e => ({ ...e, project: o.project.code, id: o.project.id })))
      .sort((a, b) => 'hml'.indexOf(a.level[0]) - 'hml'.indexOf(b.level[0])).slice(0, 10) }),
    l_costs_by_project: async () => { const P = await names('projects', 'code'); const g = groupBy(await t('project_costs'), 'project_id'); const B = byId(await t('projects'));
      return list('Accumulated cost by project', ['Project', 'Labor', 'Material', 'Equipment', 'Total', 'Budget'], Object.entries(g).map(([id, rows]) => {
        const c = k => money(sum(rows.filter(r => r.category === k), 'amount'));
        return [P(id), c('labor'), c('material'), c('equipment'), money(sum(rows, 'amount')), money(B[id]?.budget)]; }), 'operations/project_costs', true); },
    l_tickets_recent: async () => { const P = await names('projects', 'code'); return list('Recent work tickets', ['Ticket', 'Project', 'Date', 'Mode', 'Status'],
      (await t('work_tickets')).slice().sort((a, b) => b.work_date.localeCompare(a.work_date)).map(x => [x.ticket_no, P(x.project_id), x.work_date, x.entry_mode, x.status]), 'operations/work_tickets'); },
    l_my_tickets: async () => { const P = await names('projects', 'code'); return list('My work tickets', ['Ticket', 'Project', 'Date', 'Status'],
      (await t('work_tickets')).filter(x => x.supervisor_id === user.employee_id || (x.crew || []).some(c => c.employee_id === user.employee_id)).sort((a, b) => b.work_date.localeCompare(a.work_date))
        .map(x => [x.ticket_no, P(x.project_id), x.work_date, x.status]), 'operations/work_tickets'); },
    l_my_schedule: async () => { const C = await names('training_courses'), P = await names('projects', 'code'), PR = byId(await t('projects'));
      const rows = [...(await mine('training_schedules')).filter(s => s.status !== 'cancelled' && s.end_date >= today()).map(s => [s.start_date, s.end_date, 'Training', C(s.course_id)]),
        ...(await mine('project_manning')).filter(m => m.end_date >= today() && live(PR[m.project_id]?.status)).map(m => [m.start_date, m.end_date, 'Project', `${P(m.project_id)} - ${m.position}`]),
        ...(await mine('leaves')).filter(l => l.end_date >= today() && l.status !== 'rejected').map(l => [l.start_date, l.end_date, 'Leave', `${l.leave_type} (${l.status})`])].sort((a, b) => a[0].localeCompare(b[0]));
      return list('My schedule', ['From', 'To', 'Type', 'Details'], rows, 'self/my_trainings', true); },
    l_mps: async () => { const Wn = await names('wells'), M = await names('machines', 'code'); return list('Master schedule', ['Well', 'Operation', 'Start', 'Machine', 'Status'],
      (await t('mps_lines')).sort((a, b) => a.start_date.localeCompare(b.start_date)).map(l => [Wn(l.well_id), l.operation, l.start_date, M(l.machine_id), l.status]), 'planning/mps'); },
    l_mrp_runs: async () => list('MRP runs', ['Run', 'Date', 'Projects', 'Status'], (await t('mrp_runs')).slice().reverse().map(r => [r.run_no, String(r.run_date).slice(0, 10), r.result?.plans?.length || 0, r.status]), 'planning/mrp'),
    l_pm_schedule: async () => { const M = await names('machines', 'code'); return list('Preventive maintenance schedule', ['Machine', 'Type', 'From', 'To', 'Status'],
      (await t('maintenance_plans')).filter(p => p.status !== 'done').sort((a, b) => a.start_date.localeCompare(b.start_date)).map(p => [M(p.machine_id), p.pm_type, p.start_date, p.end_date, p.status]), 'assets/maintenance_plans'); },
    l_machines: async () => list('Fleet status', ['Code', 'Machine', 'Operation', 'Status'], (await t('machines')).map(m => [m.code, m.name, m.operation, m.status]), 'assets/machines'),
    l_trainings_upcoming: async () => { const E = await names('employees'), C = await names('training_courses'); return list('Upcoming trainings', ['Employee', 'Course', 'Start', 'Status'],
      (await t('training_schedules')).filter(s => ['planned', 'confirmed'].includes(s.status)).sort((a, b) => a.start_date.localeCompare(b.start_date)).map(s => [E(s.employee_id), C(s.course_id), s.start_date, s.status]), 'hr/training_schedules', true); },
    l_cert_expiring: async () => { const E = await names('employees'), C = await names('training_courses'); return list('Certificates expiring / expired', ['Employee', 'Course', 'Expiry'],
      (await t('training_records')).filter(r => r.expiry_date && r.expiry_date <= addDays(today(), 60)).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date)).map(r => [E(r.employee_id), C(r.course_id), r.expiry_date]), 'hr/compliance'); },
    l_leave_requests: async () => { const E = await names('employees'); return list('Leave requests', ['Employee', 'Type', 'From', 'To'], (await t('leaves')).filter(l => l.status === 'requested').map(l => [E(l.employee_id), l.leave_type, l.start_date, l.end_date]), 'hr/leaves'); },
    l_ts_summary: async () => { const s = await timeSummary(addDays(today(), -30), today()); return list(`Hours & days, last 30 days (limit ${s.limit} consecutive days)`, ['Employee', 'Reg h', 'OT h', 'Days', 'Consecutive'],
      s.rows.map(r => [r.name, r.regular_hours, r.ot_hours, r.days, r.consecutive_days > s.limit ? `${r.consecutive_days} !` : r.consecutive_days]), 'hr/timekeeping', true); },
    l_payroll_runs: async () => list('Payroll runs', ['Run', 'Gross', 'Net', 'Status'], (await t('payroll_runs')).slice().reverse().map(r => [r.name, money(r.total_gross), money(r.total_net), r.status]), 'hr/payroll'),
    l_requisitions: async () => list('Open requisitions', ['Item', 'Qty', 'Order by', 'Reason'], (await t('requisitions')).filter(r => r.status === 'open').map(r => [r.description, r.qty, r.order_by, r.reason]), 'procurement/requisitions'),
    l_rfqs: async () => { const S = await names('suppliers'); return list('RFQs', ['RFQ', 'Supplier', 'Due', 'Status'], (await t('rfqs')).slice().reverse().map(r => [r.rfq_no, S(r.supplier_id) || 'No supplier', r.due_date, r.status]), 'procurement/rfqs'); },
    l_po_recent: async () => { const S = await names('suppliers'); return list('Purchase orders', ['PO', 'Supplier', 'Total', 'Status'], (await t('purchase_orders')).slice().reverse().map(p => [p.po_no, S(p.supplier_id), money(p.total), p.status]), 'procurement/purchase_orders'); },
    l_low_stock: async () => list('Items at or below reorder level', ['Code', 'Item', 'On hand', 'Reorder at'], (await lowStock()).map(i => [i.code, i.name, num(i.on_hand), i.reorder_level]), 'inventory/items'),
    l_qa_queue: async () => { const I = await names('items'); return list('Awaiting QA inspection', ['Ref', 'Item', 'Qty'], (await t('stock_moves')).filter(m => m.qa_status === 'pending').map(m => [m.ref, I(m.item_id), m.qty]), 'inventory/qa'); },
    l_receipts_due: async () => { const S = await names('suppliers'); return list('Purchase orders to receive', ['PO', 'Supplier', 'Expected', 'Status'],
      (await t('purchase_orders')).filter(p => ['approved', 'partially received'].includes(p.status)).map(p => [p.po_no, S(p.supplier_id), p.expected_date, p.status]), 'inventory/receive'); },
    l_moves_recent: async () => { const I = await names('items'); return list('Recent stock moves', ['Date', 'Type', 'Item', 'Qty', 'Ref'],
      (await t('stock_moves')).slice().reverse().map(m => [String(m.move_date).slice(0, 10), m.move_type, I(m.item_id), m.qty, m.ref]), 'inventory/stock_moves', true); },
    l_project_materials: async () => { const I = await names('items'), P = await names('projects', 'code'), PR = byId(await t('projects'));
      return list('Materials to issue', ['Project', 'Item', 'Required', 'Issued'], (await t('project_materials')).filter(m => live(PR[m.project_id]?.status) && num(m.qty_issued) < num(m.qty_required))
        .map(m => [P(m.project_id), I(m.item_id), m.qty_required, num(m.qty_issued)]), 'inventory/issue', true); },
    l_orders: async () => { const C = await names('customers'); return list('Sales orders', ['Order', 'Customer', 'Operation', 'Amount', 'Status'],
      (await t('sales_orders')).slice().reverse().map(o => [o.so_no, C(o.customer_id), o.operation, money(o.amount), o.status]), 'sales/sales_orders', true); },
    l_ar_open: async () => { const C = await names('customers'); return list('Open receivables', ['Invoice', 'Customer', 'Due', 'Amount'], (await openDocs('invoices')).map(i => [i.invoice_no, C(i.customer_id), i.due_date, money(i.amount)]), 'finance/invoices'); },
    l_ap_due: async () => { const S = await names('suppliers'); return list('Open payables', ['Bill', 'Supplier', 'Due', 'Amount'], (await openDocs('bills')).map(i => [i.bill_no, S(i.supplier_id), i.due_date, money(i.amount)]), 'finance/bills'); },
    l_journal_recent: async () => { const A = await names('accounts'); return list('Recent journal entries', ['Date', 'Ref', 'Account', 'Debit', 'Credit'],
      (await t('journal_entries')).slice().reverse().map(j => [j.entry_date, j.ref, A(j.account_id), money(j.debit), money(j.credit)]), 'finance/journal_entries', true); },
    l_notifications: async () => list('Notifications', ['When', 'Title', 'Details'], (await t('notifications')).filter(n => n.role === user.role || n.user_id === user.id).reverse().map(n => [String(n.created_at).slice(0, 10), n.title, n.body]), null, true),

    // ---- Approvals inbox: work-limit alerts + POs waiting on this role ----
    approvals: async () => {
      const E = await names('employees'), S = await names('suppliers'), P = await names('projects', 'code'), items = [];
      if (['rig_manager', 'operations_head', 'admin'].includes(user.role))
        for (const a of (await t('work_limit_alerts')).filter(a => a.status === 'pending'))
          items.push({ kind: 'work_limit', id: a.id, title: `${E(a.employee_id)} - ${a.consecutive_days} consecutive days`, text: `Limit is ${a.limit_days} days. Project ${P(a.project_id)}, as of ${a.as_of}.` });
      for (const p of (await t('purchase_orders')).filter(p => p.status === 'pending approval' && (p.current_approver === user.role || user.role === 'admin')))
        items.push({ kind: 'po', id: p.id, title: `${p.po_no} - ${S(p.supplier_id)}`, text: `Total ${money(p.total)}. Waiting for ${ROLES[p.current_approver]?.label || p.current_approver}.` });
      return { type: 'approvals', title: 'Waiting for your approval', items, wide: true };
    },
  };

  const role = ROLES[user.role] || ROLES.employee;
  const widgets = [];
  for (const id of role.widgets) if (W[id]) widgets.push({ id, ...(await W[id]()) });
  return { role: role.label, widgets };
}
