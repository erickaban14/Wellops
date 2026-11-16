// Role profiles: which apps each role can open and which widgets build its dashboard.
const R = (label, group, modules, widgets) => ({ label, group, modules, widgets });

export const ROLES = {
  admin: R('System Administrator', 'System', ['sales', 'planning', 'operations', 'assets', 'procurement', 'inventory', 'hr', 'finance', 'settings'],
    ['k_active_projects', 'k_exceptions', 'k_po_pending', 'k_low_stock', 'approvals', 'l_projects', 'l_exceptions', 'l_notifications']),

  // Operations
  rig_field: R('Rig Field Personnel', 'Operations', ['operations', 'self'], ['k_my_hours', 'k_my_days', 'k_tickets_today', 'k_my_trainings', 'l_my_tickets', 'l_my_schedule']),
  rig_supervisor: R('Rig Supervisor', 'Operations', ['operations', 'self'], ['k_active_projects', 'k_tickets_today', 'k_tickets_draft', 'k_exceptions', 'l_projects', 'l_my_tickets', 'l_exceptions']),
  rig_manager: R('Rig Manager', 'Operations', ['operations', 'planning', 'assets', 'self'],
    ['k_active_projects', 'k_exceptions', 'k_work_alerts', 'k_cost_to_date', 'approvals', 'l_projects', 'l_exceptions', 'l_tickets_recent']),
  operations_head: R('Operations Head', 'Operations', ['operations', 'planning', 'assets', 'sales', 'self'],
    ['k_active_projects', 'k_exceptions', 'k_machines_avail', 'k_cost_to_date', 'l_projects', 'l_exceptions', 'l_costs_by_project', 'l_mps']),
  dispatcher: R('Dispatcher', 'Operations', ['operations', 'assets', 'inventory', 'self'], ['k_active_projects', 'k_machines_avail', 'k_pm_due', 'k_mps_firmed', 'l_mps', 'l_pm_schedule', 'l_projects']),

  // Engineering
  engineering_manager: R('Engineering Manager', 'Engineering', ['assets', 'planning', 'operations', 'self'], ['k_machines_avail', 'k_pm_due', 'k_machines_maint', 'k_exceptions', 'l_pm_schedule', 'l_machines', 'l_exceptions']),
  machine_engineer: R('Machine Engineer', 'Engineering', ['assets', 'operations', 'self'], ['k_machines_avail', 'k_pm_due', 'k_machines_maint', 'l_pm_schedule', 'l_machines']),

  // Logistics & planning
  logistics_head: R('Logistics Head', 'Logistics', ['inventory', 'procurement', 'operations', 'self'], ['k_low_stock', 'k_open_reqs', 'k_receipts_due', 'k_active_projects', 'l_low_stock', 'l_receipts_due', 'l_projects']),
  planner: R('Planner', 'Planning', ['planning', 'operations', 'assets', 'inventory', 'hr', 'self'], ['k_mps_draft', 'k_mps_firmed', 'k_mrp_pending', 'k_machines_avail', 'l_mps', 'l_mrp_runs', 'l_pm_schedule', 'l_trainings_upcoming']),

  // Procurement
  procurement_manager: R('Procurement Manager', 'Procurement', ['procurement', 'inventory', 'self'], ['k_po_pending', 'k_open_reqs', 'k_open_rfqs', 'k_po_open', 'approvals', 'l_requisitions', 'l_po_recent']),
  buyer: R('Buyer', 'Procurement', ['procurement', 'self'], ['k_open_reqs', 'k_open_rfqs', 'k_po_open', 'k_low_stock', 'l_requisitions', 'l_rfqs', 'l_po_recent']),

  // Warehouse
  warehouse_manager: R('Warehouse Manager', 'Warehouse', ['inventory', 'procurement', 'self'], ['k_stock_value', 'k_low_stock', 'k_pending_qa', 'k_receipts_due', 'l_low_stock', 'l_qa_queue', 'l_moves_recent']),
  warehouse_supervisor: R('Warehouse Supervisor', 'Warehouse', ['inventory', 'self'], ['k_low_stock', 'k_pending_qa', 'k_receipts_due', 'k_counts_open', 'l_qa_queue', 'l_receipts_due', 'l_moves_recent']),
  receiving_clerk: R('Receiving Clerk', 'Warehouse', ['inventory', 'self'], ['k_receipts_due', 'k_pending_qa', 'l_receipts_due', 'l_qa_queue']),
  issuing_clerk: R('Issuing Clerk', 'Warehouse', ['inventory', 'self'], ['k_active_projects', 'k_low_stock', 'l_project_materials', 'l_moves_recent']),
  inventory_clerk: R('Inventory Clerk', 'Warehouse', ['inventory', 'self'], ['k_stock_value', 'k_low_stock', 'k_counts_open', 'l_low_stock', 'l_moves_recent']),

  // Sales
  sales_manager: R('Sales Manager', 'Sales', ['sales', 'self'], ['k_open_quotes', 'k_confirmed_orders', 'k_order_value', 'k_ar_open', 'l_orders', 'l_projects']),
  sales_executive: R('Sales Executive', 'Sales', ['sales', 'self'], ['k_open_quotes', 'k_confirmed_orders', 'k_order_value', 'l_orders']),
  sales_coordinator: R('Sales Coordinator', 'Sales', ['sales', 'self'], ['k_open_quotes', 'k_confirmed_orders', 'k_active_projects', 'l_orders', 'l_projects']),
  sales_dispatch: R('Dispatch (Sales)', 'Sales', ['sales', 'operations', 'self'], ['k_confirmed_orders', 'k_active_projects', 'k_machines_avail', 'l_orders', 'l_mps']),

  // Finance
  finance_manager: R('Finance Manager', 'Finance', ['finance', 'procurement', 'sales', 'hr', 'self'], ['k_ar_open', 'k_ap_due', 'k_cost_to_date', 'k_po_pending', 'approvals', 'l_costs_by_project', 'l_ar_open', 'l_ap_due']),
  finance_controller: R('Finance Controller', 'Finance', ['finance', 'procurement', 'sales', 'hr', 'self'], ['k_ar_open', 'k_ap_due', 'k_cost_to_date', 'k_po_pending', 'approvals', 'l_costs_by_project', 'l_ar_open', 'l_ap_due']),
  asset_officer: R('Asset Officer', 'Finance', ['assets', 'finance', 'self'], ['k_asset_value', 'k_machines_avail', 'k_machines_maint', 'k_pm_due', 'l_machines', 'l_pm_schedule']),
  ar_clerk: R('Accounts Receivable Clerk', 'Finance', ['finance', 'sales', 'self'], ['k_ar_open', 'k_inv_draft', 'k_confirmed_orders', 'l_ar_open', 'l_orders']),
  ap_clerk: R('Accounts Payable Clerk', 'Finance', ['finance', 'procurement', 'self'], ['k_ap_due', 'k_bills_draft', 'k_po_open', 'l_ap_due', 'l_po_recent']),
  gl_bookkeeper: R('GL Bookkeeper', 'Finance', ['finance', 'self'], ['k_ar_open', 'k_ap_due', 'k_cost_to_date', 'l_journal_recent', 'l_costs_by_project']),

  // HR
  hr_head: R('Human Resource Head', 'HR', ['hr', 'self'], ['k_headcount', 'k_training_due', 'k_cert_expiring', 'k_leave_requests', 'l_trainings_upcoming', 'l_cert_expiring', 'l_leave_requests']),
  timekeeper: R('Timekeeper', 'HR', ['hr', 'self'], ['k_ts_unconsolidated', 'k_tickets_today', 'k_work_alerts', 'k_headcount', 'l_ts_summary', 'l_tickets_recent']),
  timesheet_consolidator: R('Timesheet Consolidator', 'HR', ['hr', 'self'], ['k_ts_unconsolidated', 'k_ts_consolidated', 'k_work_alerts', 'l_ts_summary', 'l_tickets_recent']),
  payroll_officer: R('Payroll Officer', 'HR', ['hr', 'self'], ['k_payroll_draft', 'k_ts_consolidated', 'k_ts_unconsolidated', 'k_leave_requests', 'l_payroll_runs', 'l_ts_summary']),
  employee: R('Employee', 'HR', ['self'], ['k_my_hours', 'k_my_days', 'k_my_trainings', 'k_my_leaves', 'l_my_schedule', 'l_notifications']),
};
export const ROLE_KEYS = Object.keys(ROLES);
