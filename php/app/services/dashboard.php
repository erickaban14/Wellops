<?php
// Role-adaptive dashboard (port of server/services/dashboard.js). Each role profile (roles.json) lists widget ids;
// only the widgets of the signed-in role are computed, and each table is read at most once per request.

function dash_build(array $user): array
{
    global $ROLES;
    $cur = (string) setting('currency', 'USD');
    $money = fn($v) => $cur . ' ' . number_format(round(num($v)), 0, '.', ',');
    $kpi = fn($title, $value, $link, $tone = '', $sub = '') => ['type' => 'kpi', 'title' => $title, 'value' => $value, 'link' => $link, 'tone' => $tone, 'sub' => $sub];
    $list = fn($title, $columns, $rows, $link, $wide = false) => ['type' => 'list', 'title' => $title, 'columns' => $columns, 'rows' => array_slice(array_values($rows), 0, 8), 'link' => $link] + ($wide ? ['wide' => true] : []);
    $live = fn($s) => !in_array($s, ['completed', 'done', 'cancelled'], true);

    $cache = [];
    $t = function (string $name) use (&$cache) { return $cache[$name] ??= Db::list($name); };
    $names = function (string $table, string $key = 'name') use ($t) {
        $m = by_id($t($table));
        return fn($id) => ($m[$id ?? '']  [$key] ?? '') ?: '';
    };
    $ov = null;
    $overviews = function () use (&$ov, $t) {
        return $ov ??= array_map(fn($p) => ops_overview($p['id'], $t), array_values(array_filter($t('projects'), fn($p) => in_array($p['status'] ?? '', ['active', 'planned'], true))));
    };
    $mine = fn($table) => array_values(array_filter($t($table), fn($r) => ($r['employee_id'] ?? null) === $user['employee_id']));
    $lowStock = fn() => array_values(array_filter($t('items'), fn($i) => num($i['reorder_level'] ?? 0) > 0 && num($i['on_hand'] ?? 0) <= num($i['reorder_level'])));
    $posted = fn($table) => array_values(array_filter($t($table), fn($d) => ($d['status'] ?? '') === 'posted'));
    $count = fn($table, $f) => count(array_filter($t($table), $f));
    $soon = add_days(today(), 30);
    $in60 = add_days(today(), 60);
    $rev = fn($rows) => array_reverse(array_values($rows));
    $sortBy = function ($rows, $key, $dir = 1) {
        $rows = array_values($rows);
        usort($rows, fn($a, $b) => $dir * strcmp((string) ($a[$key] ?? ''), (string) ($b[$key] ?? '')));
        return $rows;
    };
    $st = fn($r, $f) => ($r['status'] ?? null) === $f;

    $W = [
        // ---- KPI tiles ----
        'k_active_projects' => fn() => $kpi('Active projects', $count('projects', fn($p) => $st($p, 'active')), 'operations/projects'),
        'k_exceptions' => function () use ($kpi, $overviews) {
            $n = sum($overviews(), fn($o) => count(array_filter($o['exceptions'], fn($e) => $e['level'] !== 'low')));
            return $kpi('Open exceptions', (int) $n, 'operations/projects', $n ? 'bad' : 'good');
        },
        'k_work_alerts' => function () use ($kpi, $count, $st) {
            $n = $count('work_limit_alerts', fn($a) => $st($a, 'pending'));
            return $kpi('Work-limit approvals', $n, 'operations/work_limit_alerts', $n ? 'warn' : 'good', 'Limit ' . setting('max_work_days', 15) . ' days');
        },
        'k_cost_to_date' => fn() => $kpi('Project cost to date', $money(sum($t('project_costs'), 'amount')), 'operations/project_costs'),
        'k_tickets_today' => fn() => $kpi('Work tickets today', $count('work_tickets', fn($x) => ($x['work_date'] ?? null) === today()), 'operations/work_tickets'),
        'k_tickets_draft' => fn() => $kpi('Draft tickets', $count('work_tickets', fn($x) => $st($x, 'draft')), 'operations/work_tickets', 'warn'),
        'k_machines_avail' => fn() => $kpi('Machines available', $count('machines', fn($m) => $st($m, 'available')) . ' / ' . $count('machines', fn($m) => !$st($m, 'retired')), 'assets/machines'),
        'k_machines_maint' => fn() => $kpi('In maintenance', $count('machines', fn($m) => $st($m, 'maintenance')), 'assets/machines', 'warn'),
        'k_pm_due' => fn() => $kpi('PM due in 30 days', $count('maintenance_plans', fn($p) => !$st($p, 'done') && ($p['start_date'] ?? '9999') <= $soon), 'assets/maintenance_plans', 'warn'),
        'k_asset_value' => fn() => $kpi('Asset register value', $money(sum($t('machines'), 'purchase_cost')), 'assets/machines'),
        'k_mps_draft' => fn() => $kpi('MPS lines to firm', $count('mps_lines', fn($l) => $st($l, 'draft')), 'planning/mps'),
        'k_mps_firmed' => fn() => $kpi('Firmed, awaiting MRP', $count('mps_lines', fn($l) => $st($l, 'firmed')), 'planning/mrp', 'warn'),
        'k_mrp_pending' => fn() => $kpi('MRP runs to approve/firm', $count('mrp_runs', fn($r) => !$st($r, 'firmed')), 'planning/mrp', 'warn'),
        'k_open_reqs' => fn() => $kpi('Open requisitions', $count('requisitions', fn($r) => $st($r, 'open')), 'procurement/requisitions'),
        'k_open_rfqs' => fn() => $kpi('Open RFQs', $count('rfqs', fn($r) => in_array($r['status'] ?? '', ['draft', 'sent', 'quoted'], true)), 'procurement/rfqs'),
        'k_po_pending' => function () use ($kpi, $count, $st) {
            $n = $count('purchase_orders', fn($p) => ($p['status'] ?? '') === 'pending approval');
            return $kpi('POs awaiting approval', $n, 'procurement/purchase_orders', $n ? 'warn' : 'good');
        },
        'k_po_open' => fn() => $kpi('POs to receive', $count('purchase_orders', fn($p) => in_array($p['status'] ?? '', ['approved', 'partially received'], true)), 'procurement/purchase_orders'),
        'k_receipts_due' => fn() => $kpi('POs to receive', $count('purchase_orders', fn($p) => in_array($p['status'] ?? '', ['approved', 'partially received'], true)), 'inventory/receive'),
        'k_low_stock' => function () use ($kpi, $lowStock) { $n = count($lowStock()); return $kpi('Items at reorder level', $n, 'inventory/items', $n ? 'bad' : 'good'); },
        'k_pending_qa' => fn() => $kpi('Awaiting QA', $count('stock_moves', fn($m) => ($m['qa_status'] ?? '') === 'pending'), 'inventory/qa', 'warn'),
        'k_stock_value' => fn() => $kpi('Stock value', $money(sum($t('items'), fn($i) => num($i['on_hand'] ?? 0) * num($i['unit_cost'] ?? 0))), 'inventory/items'),
        'k_counts_open' => fn() => $kpi('Open stock counts', $count('stock_counts', fn($c) => $st($c, 'draft')), 'inventory/counts'),
        'k_open_quotes' => fn() => $kpi('Open quotations', $count('sales_orders', fn($o) => $st($o, 'quotation')), 'sales/sales_orders'),
        'k_confirmed_orders' => fn() => $kpi('Orders in progress', $count('sales_orders', fn($o) => in_array($o['status'] ?? '', ['confirmed', 'planned', 'in progress'], true)), 'sales/sales_orders'),
        'k_order_value' => fn() => $kpi('Order book value', $money(sum(array_filter($t('sales_orders'), fn($o) => !in_array($o['status'] ?? '', ['cancelled', 'quotation'], true)), 'amount')), 'sales/sales_orders'),
        'k_ar_open' => fn() => $kpi('Receivables', $money(sum($posted('invoices'), 'amount')), 'finance/invoices'),
        'k_ap_due' => fn() => $kpi('Payables', $money(sum($posted('bills'), 'amount')), 'finance/bills'),
        'k_inv_draft' => fn() => $kpi('Draft invoices', $count('invoices', fn($i) => $st($i, 'draft')), 'finance/invoices'),
        'k_bills_draft' => fn() => $kpi('Bills to post', $count('bills', fn($i) => $st($i, 'draft')), 'finance/bills', 'warn'),
        'k_headcount' => fn() => $kpi('Active employees', $count('employees', fn($e) => !$st($e, 'inactive')), 'hr/employees'),
        'k_training_due' => fn() => $kpi('Trainings scheduled', $count('training_schedules', fn($s) => in_array($s['status'] ?? '', ['planned', 'confirmed'], true)), 'hr/training_schedules'),
        'k_cert_expiring' => function () use ($kpi, $count, $in60) {
            $n = $count('training_records', fn($r) => truthy($r['expiry_date'] ?? null) && $r['expiry_date'] <= $in60);
            return $kpi('Certificates expiring (60d)', $n, 'hr/compliance', $n ? 'warn' : 'good');
        },
        'k_leave_requests' => fn() => $kpi('Leave requests', $count('leaves', fn($l) => $st($l, 'requested')), 'hr/leaves'),
        'k_ts_unconsolidated' => function () use ($kpi, $count, $st) { $n = $count('timesheets', fn($x) => $st($x, 'captured')); return $kpi('Timesheets to consolidate', $n, 'hr/timekeeping', $n ? 'warn' : 'good'); },
        'k_ts_consolidated' => fn() => $kpi('Consolidated, unpaid', $count('timesheets', fn($x) => $st($x, 'consolidated')), 'hr/timekeeping'),
        'k_payroll_draft' => fn() => $kpi('Payroll runs in draft', $count('payroll_runs', fn($r) => $st($r, 'draft')), 'hr/payroll'),
        'k_my_hours' => fn() => $kpi('My hours (30 days)', r2(sum(array_filter($mine('timesheets'), fn($x) => ($x['work_date'] ?? '') >= add_days(today(), -30)), fn($x) => num($x['regular_hours'] ?? 0) + num($x['ot_hours'] ?? 0))), 'self/my_timesheets'),
        'k_my_days' => fn() => $kpi('My days worked (30 days)', count(array_unique(array_column(array_filter($mine('timesheets'), fn($x) => ($x['work_date'] ?? '') >= add_days(today(), -30)), 'work_date'))), 'self/my_timesheets'),
        'k_my_trainings' => fn() => $kpi('My upcoming trainings', count(array_filter($mine('training_schedules'), fn($s) => in_array($s['status'] ?? '', ['planned', 'confirmed'], true))), 'self/my_trainings'),
        'k_my_leaves' => fn() => $kpi('My leave requests', count(array_filter($mine('leaves'), fn($l) => $st($l, 'requested'))), 'self/my_leaves'),

        // ---- Lists ----
        'l_projects' => fn() => ['type' => 'projects', 'title' => 'Project progress: planned vs actual', 'wide' => true, 'rows' => array_map(fn($o) => [
            'id' => $o['project']['id'], 'code' => $o['project']['code'] ?? null, 'name' => $o['project']['name'] ?? null, 'status' => $o['project']['status'] ?? null,
            'planned' => $o['planned_pct'], 'actual' => $o['actual_pct'], 'deviation' => $o['deviation'], 'cost' => $o['cost'], 'budget' => $o['budget'],
            'trend' => array_map(fn($x) => [$x['planned'], $x['actual']], $o['trend']),
            'exceptions' => count(array_filter($o['exceptions'], fn($e) => $e['level'] !== 'low'))], $overviews())],
        'l_exceptions' => function () use ($overviews) {
            $rows = [];
            foreach ($overviews() as $o) foreach ($o['exceptions'] as $e) $rows[] = $e + ['project' => $o['project']['code'] ?? null, 'id' => $o['project']['id']];
            usort($rows, fn($a, $b) => strpos('hml', $a['level'][0]) <=> strpos('hml', $b['level'][0]));
            return ['type' => 'exceptions', 'title' => 'Exceptions & deviations to date', 'rows' => array_slice($rows, 0, 10)];
        },
        'l_costs_by_project' => function () use ($names, $t, $list, $money) {
            $P = $names('projects', 'code');
            $B = by_id($t('projects'));
            $rows = [];
            foreach (group_by($t('project_costs'), 'project_id') as $id => $rs) {
                $c = fn($k) => $money(sum(array_filter($rs, fn($r) => ($r['category'] ?? null) === $k), 'amount'));
                $rows[] = [$P($id), $c('labor'), $c('material'), $c('equipment'), $money(sum($rs, 'amount')), $money($B[$id]['budget'] ?? 0)];
            }
            return $list('Accumulated cost by project', ['Project', 'Labor', 'Material', 'Equipment', 'Total', 'Budget'], $rows, 'operations/project_costs', true);
        },
        'l_tickets_recent' => function () use ($names, $t, $list, $sortBy) {
            $P = $names('projects', 'code');
            return $list('Recent work tickets', ['Ticket', 'Project', 'Date', 'Mode', 'Status'],
                array_map(fn($x) => [$x['ticket_no'] ?? null, $P($x['project_id'] ?? null), $x['work_date'] ?? null, $x['entry_mode'] ?? null, $x['status'] ?? null], $sortBy($t('work_tickets'), 'work_date', -1)), 'operations/work_tickets');
        },
        'l_my_tickets' => function () use ($names, $t, $list, $sortBy, $user) {
            $P = $names('projects', 'code');
            $mine = array_filter($t('work_tickets'), function ($x) use ($user) {
                if (($x['supervisor_id'] ?? null) === $user['employee_id']) return true;
                foreach ($x['crew'] ?? [] as $c) if (($c['employee_id'] ?? null) === $user['employee_id']) return true;
                return false;
            });
            return $list('My work tickets', ['Ticket', 'Project', 'Date', 'Status'],
                array_map(fn($x) => [$x['ticket_no'] ?? null, $P($x['project_id'] ?? null), $x['work_date'] ?? null, $x['status'] ?? null], $sortBy($mine, 'work_date', -1)), 'operations/work_tickets');
        },
        'l_my_schedule' => function () use ($names, $t, $list, $mine, $live) {
            $C = $names('training_courses');
            $P = $names('projects', 'code');
            $PR = by_id($t('projects'));
            $rows = [];
            foreach ($mine('training_schedules') as $s) if (($s['status'] ?? '') !== 'cancelled' && ($s['end_date'] ?? '') >= today()) $rows[] = [$s['start_date'], $s['end_date'], 'Training', $C($s['course_id'] ?? null)];
            foreach ($mine('project_manning') as $m) if (($m['end_date'] ?? '') >= today() && $live($PR[$m['project_id'] ?? '']['status'] ?? null)) $rows[] = [$m['start_date'], $m['end_date'], 'Project', $P($m['project_id'] ?? null) . ' - ' . ($m['position'] ?? '')];
            foreach ($mine('leaves') as $l) if (($l['end_date'] ?? '') >= today() && ($l['status'] ?? '') !== 'rejected') $rows[] = [$l['start_date'], $l['end_date'], 'Leave', ($l['leave_type'] ?? '') . ' (' . ($l['status'] ?? '') . ')'];
            usort($rows, fn($a, $b) => strcmp((string) $a[0], (string) $b[0]));
            return $list('My schedule', ['From', 'To', 'Type', 'Details'], $rows, 'self/my_trainings', true);
        },
        'l_mps' => function () use ($names, $t, $list, $sortBy) {
            $Wn = $names('wells');
            $M = $names('machines', 'code');
            return $list('Master schedule', ['Well', 'Operation', 'Start', 'Machine', 'Status'],
                array_map(fn($l) => [$Wn($l['well_id'] ?? null), $l['operation'] ?? null, $l['start_date'] ?? null, $M($l['machine_id'] ?? null), $l['status'] ?? null], $sortBy($t('mps_lines'), 'start_date')), 'planning/mps');
        },
        'l_mrp_runs' => fn() => $list('MRP runs', ['Run', 'Date', 'Projects', 'Status'],
            array_map(fn($r) => [$r['run_no'] ?? null, substr((string) ($r['run_date'] ?? ''), 0, 10), count($r['result']['plans'] ?? []), $r['status'] ?? null], $rev($t('mrp_runs'))), 'planning/mrp'),
        'l_pm_schedule' => function () use ($names, $t, $list, $sortBy) {
            $M = $names('machines', 'code');
            return $list('Preventive maintenance schedule', ['Machine', 'Type', 'From', 'To', 'Status'],
                array_map(fn($p) => [$M($p['machine_id'] ?? null), $p['pm_type'] ?? null, $p['start_date'] ?? null, $p['end_date'] ?? null, $p['status'] ?? null],
                    $sortBy(array_filter($t('maintenance_plans'), fn($p) => ($p['status'] ?? '') !== 'done'), 'start_date')), 'assets/maintenance_plans');
        },
        'l_machines' => fn() => $list('Fleet status', ['Code', 'Machine', 'Operation', 'Status'], array_map(fn($m) => [$m['code'] ?? null, $m['name'] ?? null, $m['operation'] ?? null, $m['status'] ?? null], $t('machines')), 'assets/machines'),
        'l_trainings_upcoming' => function () use ($names, $t, $list, $sortBy) {
            $E = $names('employees');
            $C = $names('training_courses');
            return $list('Upcoming trainings', ['Employee', 'Course', 'Start', 'Status'],
                array_map(fn($s) => [$E($s['employee_id'] ?? null), $C($s['course_id'] ?? null), $s['start_date'] ?? null, $s['status'] ?? null],
                    $sortBy(array_filter($t('training_schedules'), fn($s) => in_array($s['status'] ?? '', ['planned', 'confirmed'], true)), 'start_date')), 'hr/training_schedules', true);
        },
        'l_cert_expiring' => function () use ($names, $t, $list, $sortBy, $in60) {
            $E = $names('employees');
            $C = $names('training_courses');
            return $list('Certificates expiring / expired', ['Employee', 'Course', 'Expiry'],
                array_map(fn($r) => [$E($r['employee_id'] ?? null), $C($r['course_id'] ?? null), $r['expiry_date']],
                    $sortBy(array_filter($t('training_records'), fn($r) => truthy($r['expiry_date'] ?? null) && $r['expiry_date'] <= $in60), 'expiry_date')), 'hr/compliance');
        },
        'l_leave_requests' => function () use ($names, $t, $list) {
            $E = $names('employees');
            return $list('Leave requests', ['Employee', 'Type', 'From', 'To'],
                array_map(fn($l) => [$E($l['employee_id'] ?? null), $l['leave_type'] ?? null, $l['start_date'] ?? null, $l['end_date'] ?? null], array_filter($t('leaves'), fn($l) => ($l['status'] ?? '') === 'requested')), 'hr/leaves');
        },
        'l_ts_summary' => function () use ($list) {
            $s = hr_time_summary(add_days(today(), -30), today());
            return $list('Hours & days, last 30 days (limit ' . $s['limit'] . ' consecutive days)', ['Employee', 'Reg h', 'OT h', 'Days', 'Consecutive'],
                array_map(fn($r) => [$r['name'], $r['regular_hours'], $r['ot_hours'], $r['days'], $r['consecutive_days'] > $s['limit'] ? $r['consecutive_days'] . ' !' : $r['consecutive_days']], $s['rows']), 'hr/timekeeping', true);
        },
        'l_payroll_runs' => fn() => $list('Payroll runs', ['Run', 'Gross', 'Net', 'Status'],
            array_map(fn($r) => [$r['name'] ?? null, $money($r['total_gross'] ?? 0), $money($r['total_net'] ?? 0), $r['status'] ?? null], $rev($t('payroll_runs'))), 'hr/payroll'),
        'l_requisitions' => fn() => $list('Open requisitions', ['Item', 'Qty', 'Order by', 'Reason'],
            array_map(fn($r) => [$r['description'] ?? null, $r['qty'] ?? null, $r['order_by'] ?? null, $r['reason'] ?? null], array_filter($t('requisitions'), fn($r) => ($r['status'] ?? '') === 'open')), 'procurement/requisitions'),
        'l_rfqs' => function () use ($names, $t, $list, $rev) {
            $S = $names('suppliers');
            return $list('RFQs', ['RFQ', 'Supplier', 'Due', 'Status'], array_map(fn($r) => [$r['rfq_no'] ?? null, $S($r['supplier_id'] ?? null) ?: 'No supplier', $r['due_date'] ?? null, $r['status'] ?? null], $rev($t('rfqs'))), 'procurement/rfqs');
        },
        'l_po_recent' => function () use ($names, $t, $list, $rev, $money) {
            $S = $names('suppliers');
            return $list('Purchase orders', ['PO', 'Supplier', 'Total', 'Status'], array_map(fn($p) => [$p['po_no'] ?? null, $S($p['supplier_id'] ?? null), $money($p['total'] ?? 0), $p['status'] ?? null], $rev($t('purchase_orders'))), 'procurement/purchase_orders');
        },
        'l_low_stock' => fn() => $list('Items at or below reorder level', ['Code', 'Item', 'On hand', 'Reorder at'],
            array_map(fn($i) => [$i['code'] ?? null, $i['name'] ?? null, num($i['on_hand'] ?? 0), $i['reorder_level'] ?? null], $lowStock()), 'inventory/items'),
        'l_qa_queue' => function () use ($names, $t, $list) {
            $I = $names('items');
            return $list('Awaiting QA inspection', ['Ref', 'Item', 'Qty'], array_map(fn($m) => [$m['ref'] ?? null, $I($m['item_id'] ?? null), $m['qty'] ?? null], array_filter($t('stock_moves'), fn($m) => ($m['qa_status'] ?? '') === 'pending')), 'inventory/qa');
        },
        'l_receipts_due' => function () use ($names, $t, $list) {
            $S = $names('suppliers');
            return $list('Purchase orders to receive', ['PO', 'Supplier', 'Expected', 'Status'],
                array_map(fn($p) => [$p['po_no'] ?? null, $S($p['supplier_id'] ?? null), $p['expected_date'] ?? null, $p['status'] ?? null],
                    array_filter($t('purchase_orders'), fn($p) => in_array($p['status'] ?? '', ['approved', 'partially received'], true))), 'inventory/receive');
        },
        'l_moves_recent' => function () use ($names, $t, $list, $rev) {
            $I = $names('items');
            return $list('Recent stock moves', ['Date', 'Type', 'Item', 'Qty', 'Ref'],
                array_map(fn($m) => [substr((string) ($m['move_date'] ?? ''), 0, 10), $m['move_type'] ?? null, $I($m['item_id'] ?? null), $m['qty'] ?? null, $m['ref'] ?? null], $rev($t('stock_moves'))), 'inventory/stock_moves', true);
        },
        'l_project_materials' => function () use ($names, $t, $list, $live) {
            $I = $names('items');
            $P = $names('projects', 'code');
            $PR = by_id($t('projects'));
            return $list('Materials to issue', ['Project', 'Item', 'Required', 'Issued'],
                array_map(fn($m) => [$P($m['project_id'] ?? null), $I($m['item_id'] ?? null), $m['qty_required'] ?? null, num($m['qty_issued'] ?? 0)],
                    array_filter($t('project_materials'), fn($m) => $live($PR[$m['project_id'] ?? '']['status'] ?? null) && num($m['qty_issued'] ?? 0) < num($m['qty_required'] ?? 0))), 'inventory/issue', true);
        },
        'l_orders' => function () use ($names, $t, $list, $rev, $money) {
            $C = $names('customers');
            return $list('Sales orders', ['Order', 'Customer', 'Operation', 'Amount', 'Status'],
                array_map(fn($o) => [$o['so_no'] ?? null, $C($o['customer_id'] ?? null), $o['operation'] ?? null, $money($o['amount'] ?? 0), $o['status'] ?? null], $rev($t('sales_orders'))), 'sales/sales_orders', true);
        },
        'l_ar_open' => function () use ($names, $list, $posted, $money) {
            $C = $names('customers');
            return $list('Open receivables', ['Invoice', 'Customer', 'Due', 'Amount'], array_map(fn($i) => [$i['invoice_no'] ?? null, $C($i['customer_id'] ?? null), $i['due_date'] ?? null, $money($i['amount'] ?? 0)], $posted('invoices')), 'finance/invoices');
        },
        'l_ap_due' => function () use ($names, $list, $posted, $money) {
            $S = $names('suppliers');
            return $list('Open payables', ['Bill', 'Supplier', 'Due', 'Amount'], array_map(fn($i) => [$i['bill_no'] ?? null, $S($i['supplier_id'] ?? null), $i['due_date'] ?? null, $money($i['amount'] ?? 0)], $posted('bills')), 'finance/bills');
        },
        'l_journal_recent' => function () use ($names, $t, $list, $rev, $money) {
            $A = $names('accounts');
            return $list('Recent journal entries', ['Date', 'Ref', 'Account', 'Debit', 'Credit'],
                array_map(fn($j) => [$j['entry_date'] ?? null, $j['ref'] ?? null, $A($j['account_id'] ?? null), $money($j['debit'] ?? 0), $money($j['credit'] ?? 0)], $rev($t('journal_entries'))), 'finance/journal_entries', true);
        },
        'l_notifications' => fn() => $list('Notifications', ['When', 'Title', 'Details'],
            array_map(fn($n) => [substr((string) ($n['created_at'] ?? ''), 0, 10), $n['title'] ?? null, $n['body'] ?? null],
                $rev(array_filter($t('notifications'), fn($n) => ($n['role'] ?? null) === $user['role'] || ($n['user_id'] ?? null) === $user['id']))), null, true),

        // ---- Approvals inbox: work-limit alerts + POs waiting on this role ----
        'approvals' => function () use ($names, $t, $user, $money, $ROLES) {
            $E = $names('employees');
            $S = $names('suppliers');
            $P = $names('projects', 'code');
            $items = [];
            if (in_array($user['role'], ['rig_manager', 'operations_head', 'admin'], true)) {
                foreach (array_filter($t('work_limit_alerts'), fn($a) => ($a['status'] ?? '') === 'pending') as $a)
                    $items[] = ['kind' => 'work_limit', 'id' => $a['id'], 'title' => $E($a['employee_id'] ?? null) . ' - ' . num($a['consecutive_days'] ?? 0) . ' consecutive days',
                        'text' => 'Limit is ' . num($a['limit_days'] ?? 0) . ' days. Project ' . $P($a['project_id'] ?? null) . ', as of ' . ($a['as_of'] ?? '') . '.'];
            }
            foreach (array_filter($t('purchase_orders'), fn($p) => ($p['status'] ?? '') === 'pending approval' && (($p['current_approver'] ?? null) === $user['role'] || $user['role'] === 'admin')) as $p)
                $items[] = ['kind' => 'po', 'id' => $p['id'], 'title' => ($p['po_no'] ?? '') . ' - ' . $S($p['supplier_id'] ?? null),
                    'text' => 'Total ' . $money($p['total'] ?? 0) . '. Waiting for ' . ($ROLES[$p['current_approver'] ?? '']['label'] ?? $p['current_approver'] ?? '') . '.'];
            return ['type' => 'approvals', 'title' => 'Waiting for your approval', 'items' => $items, 'wide' => true];
        },
    ];

    $role = $ROLES[$user['role']] ?? $ROLES['employee'];
    $widgets = [];
    foreach ($role['widgets'] as $id) if (isset($W[$id])) $widgets[] = ['id' => $id] + $W[$id]();
    return ['role' => $role['label'], 'widgets' => $widgets];
}

function routes_dashboard(callable $route): void
{
    $route('GET', 'dashboard', fn() => dash_build(Auth::$user));
}
