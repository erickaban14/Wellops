// Single source of truth for the data model. Drives: SQL schema (Supabase + on-prem mirror),
// the generic REST API, and the list/form views in the browser.
import { ROLE_KEYS } from './roles.js';

export const OPERATIONS = ['drilling', 'workover', 'surface pumping'];
export const POSITIONS = ['Rig Manager', 'Rig Supervisor', 'Toolpusher', 'Driller', 'Assistant Driller', 'Derrickman', 'Floorman',
  'Roustabout', 'Pump Supervisor', 'Pump Operator', 'Frac Crew', 'Wireline Operator', 'Coiled Tubing Operator', 'Snubbing Operator',
  'Mechanic', 'Electrician', 'HSE Officer', 'Machine Engineer', 'Office Staff'];
export const PILLARS = ['Pillar 1 - General HSE & Field Foundations', 'Pillar 2 - Well Control & Pressure Control',
  'Pillar 3 - Technical Operations & Specialty Equipment', 'Pillar 4 - Emergency Response & Survival'];
const DISCIPLINES = ['All', 'Drilling Operations', 'Pump Operations', 'Pumping & Fracturing Crew', 'Well Services & Interventions', 'Support'];

const title = s => s.replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const sel = (...options) => ({ options });
const ref = (table, o = {}) => ({ ref: table, ...o });
function M(label, module, fields, opts = {}) {
  const f = {};
  for (const [name, type = 'text', o = {}, o2 = {}] of fields) f[name] = { type, label: o.label || o2.label || title(name), ...o, ...o2 };
  return { label, module, display: f.name ? 'name' : Object.keys(f)[0], fields: f, ...opts };
}
const itemLines = [['item_id', 'ref', ref('items', { label: 'Item' })], ['description'], ['qty', 'number'], ['price', 'number']];

export const models = {
  // ---------- Settings / system ----------
  settings: M('Settings', 'settings', [['key', 'text', { req: 1 }], ['value'], ['description']], { display: 'key' }),
  users: M('Users', 'settings', [['name', 'text', { req: 1 }], ['email', 'text', { req: 1 }], ['role', 'select', sel(...ROLE_KEYS)],
    ['employee_id', 'ref', ref('employees')], ['active', 'bool'], ['password_hash', 'text', { hidden: 1 }], ['face_descriptor', 'json', { hidden: 1 }]]),
  notifications: M('Notifications', 'dashboard', [['role'], ['user_id', 'ref', ref('users')], ['title'], ['body', 'longtext'], ['kind'],
    ['ref_table'], ['ref_id'], ['read', 'bool']], { display: 'title' }),
  sync_log: M('Sync Log', 'settings', [['started_at', 'datetime'], ['finished_at', 'datetime'], ['target'], ['status'], ['rows', 'number'], ['message', 'longtext']], { display: 'started_at' }),

  // ---------- HR ----------
  employees: M('Employees', 'hr', [['emp_no', 'text', { label: 'Employee No' }], ['name', 'text', { req: 1 }], ['position', 'select', sel(...POSITIONS)],
    ['department', 'select', sel('Operations', 'Engineering', 'Logistics', 'Procurement', 'Warehouse', 'Sales', 'Finance', 'HR')],
    ['discipline', 'select', sel(...DISCIPLINES)], ['hire_date', 'date'], ['hourly_rate', 'number'], ['daily_allowance', 'number'],
    ['email'], ['phone'], ['status', 'select', sel('active', 'inactive')], ['accumulated_hours', 'number', { ro: 1 }], ['accumulated_days', 'number', { ro: 1 }]]),
  leaves: M('Leaves', 'hr', [['employee_id', 'ref', ref('employees', { req: 1 })], ['leave_type', 'select', sel('vacation', 'sick', 'emergency', 'rotation off', 'unpaid')],
    ['start_date', 'date', { req: 1 }], ['end_date', 'date', { req: 1 }], ['paid', 'bool'], ['status', 'select', sel('requested', 'approved', 'rejected')], ['remarks']],
    { display: 'leave_type', modules: ['hr', 'self'] }),
  training_courses: M('Training Courses', 'hr', [['code'], ['name', 'text', { req: 1 }], ['pillar', 'select', sel(...PILLARS)], ['standard'],
    ['discipline', 'select', sel(...DISCIPLINES)], ['duration_days', 'number'], ['validity_months', 'number'], ['provider']]),
  training_matrix: M('Training Matrix', 'hr', [['position', 'select', sel('All Personnel', ...POSITIONS)], ['course_id', 'ref', ref('training_courses', { req: 1 })], ['mandatory', 'bool']], { display: 'position' }),
  training_records: M('Training Records', 'hr', [['employee_id', 'ref', ref('employees', { req: 1 })], ['course_id', 'ref', ref('training_courses', { req: 1 })],
    ['completed_date', 'date'], ['expiry_date', 'date'], ['certificate_no']], { display: 'certificate_no' }),
  training_schedules: M('Training Schedules', 'hr', [['employee_id', 'ref', ref('employees', { req: 1 })], ['course_id', 'ref', ref('training_courses', { req: 1 })],
    ['start_date', 'date'], ['end_date', 'date'], ['status', 'select', sel('planned', 'confirmed', 'completed', 'cancelled')], ['source'],
    ['mrp_run_id', 'ref', ref('mrp_runs')], ['project_id', 'ref', ref('projects')], ['note']], { display: 'source' }),
  timesheets: M('Timesheets', 'hr', [['employee_id', 'ref', ref('employees', { req: 1 })], ['project_id', 'ref', ref('projects')], ['work_date', 'date', { req: 1 }],
    ['regular_hours', 'number'], ['ot_hours', 'number'], ['source', 'select', sel('dwt', 'manual')], ['ticket_id', 'ref', ref('work_tickets')],
    ['status', 'select', sel('captured', 'consolidated', 'paid')]], { display: 'work_date', modules: ['hr', 'operations'] }),
  payroll_runs: M('Payroll Runs', 'hr', [['name'], ['period_start', 'date'], ['period_end', 'date'], ['status', 'select', sel('draft', 'approved')],
    ['total_gross', 'number'], ['total_net', 'number']], { private: 1 }),
  payslips: M('Payslips', 'hr', [['run_id', 'ref', ref('payroll_runs')], ['employee_id', 'ref', ref('employees')], ['days_worked', 'number'], ['regular_hours', 'number'],
    ['ot_hours', 'number'], ['leave_days', 'number'], ['basic_pay', 'number'], ['ot_pay', 'number'], ['leave_pay', 'number'], ['allowances', 'number'],
    ['gross_pay', 'number'], ['deductions', 'number'], ['net_pay', 'number']], { display: 'run_id', private: 1 }),

  // ---------- Sales ----------
  customers: M('Customers', 'sales', [['name', 'text', { req: 1 }], ['contact_person'], ['email'], ['phone'], ['address']]),
  wells: M('Wells', 'sales', [['name', 'text', { req: 1 }], ['field'], ['customer_id', 'ref', ref('customers')], ['well_type', 'select', sel('oil', 'gas', 'water injection', 'geothermal')],
    ['depth_ft', 'number'], ['status', 'select', sel('planned', 'drilling', 'producing', 'shut-in', 'abandoned')], ['location']], { modules: ['sales', 'operations', 'planning'] }),
  sales_orders: M('Sales Orders', 'sales', [['so_no', 'text', { label: 'Order No', auto: 'SO-' }], ['customer_id', 'ref', ref('customers', { req: 1 })], ['well_id', 'ref', ref('wells')],
    ['operation', 'select', sel(...OPERATIONS)], ['api_code', 'text', { label: 'API Code' }], ['target_depth_ft', 'number'], ['target_flow_gpm', 'number'],
    ['requested_start', 'date'], ['amount', 'number'], ['status', 'select', sel('quotation', 'confirmed', 'planned', 'in progress', 'done', 'cancelled')], ['sales_person']],
    { display: 'so_no' }),

  // ---------- Finance ----------
  invoices: M('Customer Invoices', 'finance', [['invoice_no', 'text', { auto: 'INV-' }], ['customer_id', 'ref', ref('customers', { req: 1 })], ['so_id', 'ref', ref('sales_orders', { label: 'Sales Order' })],
    ['project_id', 'ref', ref('projects')], ['invoice_date', 'date'], ['due_date', 'date'], ['amount', 'number'], ['status', 'select', sel('draft', 'posted', 'paid')]], { display: 'invoice_no' }),
  bills: M('Supplier Bills', 'finance', [['bill_no', 'text', { auto: 'BILL-' }], ['supplier_id', 'ref', ref('suppliers', { req: 1 })], ['po_id', 'ref', ref('purchase_orders', { label: 'Purchase Order' })],
    ['bill_date', 'date'], ['due_date', 'date'], ['amount', 'number'], ['status', 'select', sel('draft', 'posted', 'paid')]], { display: 'bill_no' }),
  accounts: M('Chart of Accounts', 'finance', [['code', 'text', { req: 1 }], ['name', 'text', { req: 1 }], ['type', 'select', sel('asset', 'liability', 'equity', 'income', 'expense')]]),
  journal_entries: M('Journal Entries', 'finance', [['entry_date', 'date'], ['ref'], ['memo'], ['account_id', 'ref', ref('accounts', { req: 1 })], ['debit', 'number'], ['credit', 'number'],
    ['project_id', 'ref', ref('projects')]], { display: 'ref' }),
  project_costs: M('Project Costs', 'operations', [['project_id', 'ref', ref('projects', { req: 1 })], ['cost_date', 'date'], ['category', 'select', sel('labor', 'material', 'equipment', 'services', 'other')],
    ['amount', 'number'], ['description'], ['ref']], { display: 'description', modules: ['operations', 'finance'] }),

  // ---------- Assets / machines ----------
  machines: M('Machines', 'assets', [['code', 'text', { req: 1 }], ['name', 'text', { req: 1 }], ['machine_type', 'select', sel('drilling rig', 'workover rig', 'pump unit', 'support equipment')],
    ['operation', 'select', sel(...OPERATIONS)], ['api_code', 'text', { label: 'API Codes' }], ['max_depth_ft', 'number'], ['max_flow_gpm', 'number'], ['max_pressure_psi', 'number'],
    ['horsepower', 'number'], ['accessories', 'longtext', { label: 'Accessory Tools' }], ['day_rate', 'number'], ['status', 'select', sel('available', 'deployed', 'maintenance', 'retired')],
    ['location'], ['purchase_date', 'date'], ['purchase_cost', 'number']], { modules: ['assets', 'planning'] }),
  maintenance_plans: M('Preventive Maintenance', 'assets', [['machine_id', 'ref', ref('machines', { req: 1 })], ['pm_type', 'select', sel('preventive', 'inspection', 'certification', 'corrective')],
    ['description'], ['start_date', 'date', { req: 1 }], ['end_date', 'date', { req: 1 }], ['status', 'select', sel('scheduled', 'in progress', 'done')]], { display: 'description' }),

  // ---------- Planning ----------
  api_standards: M('API Standards', 'planning', [['code', 'text', { req: 1 }], ['title'], ['operation', 'select', sel(...OPERATIONS, 'all')], ['scope', 'longtext']], { display: 'code' }),
  documents: M('Manuals & Documents', 'planning', [['title', 'text', { req: 1 }], ['doc_type', 'select', sel('manual', 'API specification', 'procedure', 'certificate')], ['api_code', 'text', { label: 'API Code' }],
    ['machine_id', 'ref', ref('machines')], ['file_name', 'text', { ro: 1 }], ['storage_path', 'text', { hidden: 1 }], ['mime', 'text', { hidden: 1 }]], { display: 'title', modules: ['planning', 'assets'] }),
  activity_templates: M('Activity Templates', 'planning', [['operation', 'select', sel(...OPERATIONS)], ['seq', 'number'], ['name', 'text', { req: 1 }], ['base_hours', 'number'], ['hours_per_1000ft', 'number']]),
  material_templates: M('Material Templates', 'planning', [['operation', 'select', sel(...OPERATIONS)], ['item_id', 'ref', ref('items', { req: 1 })], ['base_qty', 'number'], ['qty_per_1000ft', 'number']], { display: 'operation' }),
  crew_templates: M('Crew Templates', 'planning', [['operation', 'select', sel(...OPERATIONS)], ['position', 'select', sel(...POSITIONS)], ['qty', 'number']], { display: 'position' }),
  kpi_templates: M('KPI Targets', 'planning', [['operation', 'select', sel(...OPERATIONS)], ['name', 'text', { req: 1 }], ['target', 'number'], ['unit'], ['direction', 'select', sel('at most', 'at least')],
    ['auto_key', 'select', sel('', 'npt_pct', 'cost_var_pct', 'schedule_var_pct', 'incidents', 'rop'), { label: 'Auto-computed from' }]]),
  mps_lines: M('Master Schedule', 'planning', [['so_id', 'ref', ref('sales_orders', { label: 'Sales Order' })], ['well_id', 'ref', ref('wells')], ['operation', 'select', sel(...OPERATIONS)],
    ['api_code', 'text', { label: 'API Code' }], ['depth_ft', 'number'], ['flow_gpm', 'number'], ['start_date', 'date', { req: 1 }], ['machine_id', 'ref', ref('machines', { label: 'Preferred Machine' })],
    ['status', 'select', sel('draft', 'firmed', 'planned')], ['mrp_run_id', 'ref', ref('mrp_runs', { ro: 1 })]], { display: 'operation' }),
  mrp_runs: M('MRP Runs', 'planning', [['run_no'], ['run_date', 'datetime'], ['status', 'select', sel('draft', 'approved', 'firmed')], ['approved_by'], ['firmed_by'], ['result', 'json', { ro: 1 }]], { display: 'run_no' }),

  // ---------- Operations ----------
  projects: M('Projects', 'operations', [['code'], ['name', 'text', { req: 1 }], ['customer_id', 'ref', ref('customers')], ['well_id', 'ref', ref('wells')], ['so_id', 'ref', ref('sales_orders', { label: 'Sales Order' })],
    ['operation', 'select', sel(...OPERATIONS)], ['machine_id', 'ref', ref('machines')], ['start_date', 'date'], ['end_date', 'date'],
    ['status', 'select', sel('planned', 'active', 'on hold', 'completed')], ['budget', 'number'], ['mrp_run_id', 'ref', ref('mrp_runs')]], { modules: ['operations', 'planning'] }),
  project_activities: M('Project Activities', 'operations', [['project_id', 'ref', ref('projects', { req: 1 })], ['seq', 'number'], ['name', 'text', { req: 1 }], ['planned_start', 'datetime'], ['planned_end', 'datetime'],
    ['planned_hours', 'number'], ['actual_hours', 'number'], ['pct_complete', 'number'], ['status', 'select', sel('pending', 'in progress', 'done')]], { modules: ['operations', 'planning'] }),
  project_materials: M('Project Materials', 'operations', [['project_id', 'ref', ref('projects', { req: 1 })], ['item_id', 'ref', ref('items', { req: 1 })], ['qty_required', 'number'], ['qty_issued', 'number'], ['need_date', 'date']], { display: 'need_date' }),
  project_manning: M('Project Manning', 'operations', [['project_id', 'ref', ref('projects', { req: 1 })], ['position', 'select', sel(...POSITIONS)], ['employee_id', 'ref', ref('employees')],
    ['start_date', 'date'], ['end_date', 'date'], ['status', 'select', sel('assigned', 'shortage')]], { display: 'position', modules: ['operations', 'planning'] }),
  project_kpis: M('Project KPIs', 'operations', [['project_id', 'ref', ref('projects', { req: 1 })], ['name'], ['target', 'number'], ['unit'], ['direction', 'select', sel('at most', 'at least')],
    ['actual', 'number'], ['auto_key']], { modules: ['operations', 'planning'] }),
  work_tickets: M('Daily Work Tickets', 'operations', [['ticket_no', 'text', { ro: 1 }], ['client_id', 'text', { hidden: 1 }], ['project_id', 'ref', ref('projects', { req: 1 })], ['work_date', 'date', { req: 1 }],
    ['shift', 'select', sel('day', 'night')], ['supervisor_id', 'ref', ref('employees', { label: 'Supervisor' })], ['status', 'select', sel('draft', 'submitted', 'approved')],
    ['entry_mode', 'select', sel('online', 'offline')], ['incidents', 'number'], ['remarks', 'longtext'], ['synced_at', 'datetime', { ro: 1 }],
    ['lines', 'json'], ['crew', 'json'], ['materials', 'json']], { display: 'ticket_no' }),
  work_limit_alerts: M('Work Limit Alerts', 'operations', [['employee_id', 'ref', ref('employees')], ['project_id', 'ref', ref('projects')], ['as_of', 'date'], ['consecutive_days', 'number'],
    ['limit_days', 'number'], ['status', 'select', sel('pending', 'approved', 'rejected')], ['decided_by'], ['decided_at', 'datetime'], ['decision_note']], { display: 'as_of' }),

  // ---------- Procurement ----------
  suppliers: M('Suppliers', 'procurement', [['name', 'text', { req: 1 }], ['contact_person'], ['email'], ['phone'], ['payment_terms']]),
  items: M('Item Master', 'procurement', [['code', 'text', { req: 1 }], ['name', 'text', { req: 1 }], ['category', 'select', sel('supply', 'material', 'tool', 'machine', 'spare part')], ['uom', 'text', { label: 'UoM' }],
    ['unit_cost', 'number'], ['on_hand', 'number', { ro: 1 }], ['lead_time_days', 'number'], ['reorder_level', 'number'], ['reorder_qty', 'number'], ['safety_stock', 'number'],
    ['min_order_qty', 'number'], ['preferred_supplier_id', 'ref', ref('suppliers')], ['qa_required', 'bool', { label: 'QA Required on Receipt' }], ['location', 'text', { label: 'Bin Location' }]],
    { modules: ['procurement', 'inventory'] }),
  requisitions: M('Purchase Requisitions', 'procurement', [['item_id', 'ref', ref('items')], ['description'], ['qty', 'number'], ['need_date', 'date'], ['order_by', 'date'],
    ['project_id', 'ref', ref('projects')], ['mrp_run_id', 'ref', ref('mrp_runs')], ['reason', 'select', sel('MRP shortage', 'reorder level', 'machine requirement', 'manual')],
    ['status', 'select', sel('open', 'rfq', 'ordered', 'closed')]], { display: 'description' }),
  rfqs: M('Requests for Quotation', 'procurement', [['rfq_no', 'text', { label: 'RFQ No', auto: 'RFQ-' }], ['supplier_id', 'ref', ref('suppliers')], ['rfq_date', 'date'], ['due_date', 'date'],
    ['status', 'select', sel('draft', 'sent', 'quoted', 'converted', 'cancelled')], ['mrp_run_id', 'ref', ref('mrp_runs')], ['lines', 'json', { cols: itemLines }]], { display: 'rfq_no' }),
  purchase_orders: M('Purchase Orders', 'procurement', [['po_no', 'text', { label: 'PO No', auto: 'PO-' }], ['supplier_id', 'ref', ref('suppliers', { req: 1 })], ['order_date', 'date'], ['expected_date', 'date'],
    ['project_id', 'ref', ref('projects')], ['rfq_id', 'ref', ref('rfqs', { label: 'RFQ' })], ['total', 'number', { ro: 1 }],
    ['status', 'select', sel('draft', 'pending approval', 'approved', 'rejected', 'partially received', 'received'), { ro: 1 }], ['current_approver', 'text', { ro: 1 }],
    ['lines', 'json', { cols: itemLines }], ['approvals', 'json', { ro: 1 }]], { display: 'po_no' }),
  approval_rules: M('PO Approval Rules', 'procurement', [['seq', 'number'], ['min_amount', 'number', { label: 'For totals from' }], ['role', 'select', sel(...ROLE_KEYS)]], { display: 'role' }),

  // ---------- Inventory ----------
  stock_moves: M('Stock Moves', 'inventory', [['move_date', 'datetime'], ['move_type', 'select', sel('receipt', 'issue', 'return in', 'return out', 'adjustment')], ['item_id', 'ref', ref('items')],
    ['qty', 'number'], ['unit_cost', 'number'], ['po_id', 'ref', ref('purchase_orders', { label: 'Purchase Order' })], ['project_id', 'ref', ref('projects')], ['ref'],
    ['qa_status', 'select', sel('n/a', 'pending', 'passed', 'partial', 'failed')], ['remarks'], ['done_by']], { display: 'ref' }),
  qa_inspections: M('QA Inspections', 'inventory', [['move_id', 'ref', ref('stock_moves')], ['item_id', 'ref', ref('items')], ['qty_inspected', 'number'], ['qty_accepted', 'number'],
    ['qty_rejected', 'number'], ['result'], ['inspector'], ['remarks'], ['inspected_at', 'datetime']], { display: 'result' }),
  stock_counts: M('Physical Inventory', 'inventory', [['count_no'], ['count_date', 'date'], ['status', 'select', sel('draft', 'posted')], ['remarks'], ['lines', 'json']], { display: 'count_no' }),
};

// Form sections for the longer records (fields not listed fall under "General").
const SECTIONS = {
  machines: { Ratings: ['api_code', 'max_depth_ft', 'max_flow_gpm', 'max_pressure_psi', 'horsepower', 'accessories'], 'Commercial & asset': ['day_rate', 'purchase_date', 'purchase_cost'] },
  items: { Stock: ['on_hand', 'location', 'qa_required'], 'Planning (MRP)': ['lead_time_days', 'reorder_level', 'reorder_qty', 'safety_stock', 'min_order_qty', 'preferred_supplier_id'] },
  employees: { 'Pay & time': ['hourly_rate', 'daily_allowance', 'accumulated_hours', 'accumulated_days'], Contact: ['email', 'phone'] },
  sales_orders: { 'Job parameters': ['operation', 'api_code', 'target_depth_ft', 'target_flow_gpm', 'requested_start'] },
};
const MONEY = /^(amount|total|budget|debit|credit|price|unit_cost|day_rate|hourly_rate|daily_allowance|purchase_cost|total_gross|total_net|min_amount)$|_pay$|^deductions$|^allowances$/;
for (const [name, m] of Object.entries(models)) {
  m.name = name; m.modules ||= [m.module];
  if (SECTIONS[name]) m.sections = SECTIONS[name];
  for (const [k, f] of Object.entries(m.fields)) if (f.type === 'number' && MONEY.test(k)) f.money = true;
}
