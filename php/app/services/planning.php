<?php
// Planning: machine selection, master schedule (MPS), MRP run, availability board.
// Port of server/services/planning.js.

function plan_codes($s): array
{
    $out = [];
    foreach (preg_split('/[,;\/]+/', strtoupper((string) ($s ?? ''))) as $c) {
        $c = preg_replace('/API|SPEC|STD|RP|\s/', '', $c);
        if ($c !== '') $out[] = $c;
    }
    return $out;
}
function plan_open($s): bool { return !in_array($s, ['done', 'completed', 'cancelled', 'rejected'], true); }

/** Rank machines against API code, well depth, target flow rate and operation. */
function plan_select_machine(array $a): array
{
    $machines = Db::list('machines');
    $pms = Db::list('maintenance_plans');
    $projects = Db::list('projects');
    $docs = Db::list('documents');
    $stds = Db::list('api_standards');
    $api_code = $a['api_code'] ?? null;
    $operation = $a['operation'] ?? null;
    $start = $a['start'] ?? null;
    $end = $a['end'] ?? null;
    $busy = $a['busy'] ?? [];
    $depth = num($a['depth_ft'] ?? 0);
    $flow = num($a['flow_gpm'] ?? 0);
    $want = plan_codes($api_code);
    $standards = array_values(array_filter($stds, function ($s) use ($want, $operation) {
        foreach ($want as $w) if (in_array($w, plan_codes($s['code'] ?? ''), true)) return true;
        return $operation && in_array($s['operation'] ?? null, [$operation, 'all'], true);
    }));
    $ranked = [];
    foreach (array_filter($machines, fn($m) => ($m['status'] ?? '') !== 'retired') as $m) {
        $pass = [];
        $failed = [];
        $util = [];
        $mc = plan_codes($m['api_code'] ?? '');
        $test = function (bool $ok, string $text) use (&$pass, &$failed) { if ($ok) $pass[] = $text; else $failed[] = $text; };
        if ($operation) $test(($m['operation'] ?? null) === $operation, 'Operation: ' . ($m['operation'] ?? ''));
        if ($want) $test(!array_diff($want, $mc), 'API ' . (truthy($m['api_code'] ?? null) ? $m['api_code'] : 'n/a') . " vs required $api_code");
        if ($depth && num($m['max_depth_ft'] ?? 0)) { $test(num($m['max_depth_ft']) >= $depth, 'Depth rating ' . num($m['max_depth_ft']) . " ft vs $depth ft"); $util[] = $depth / num($m['max_depth_ft']); }
        if ($flow && num($m['max_flow_gpm'] ?? 0)) { $test(num($m['max_flow_gpm']) >= $flow, 'Flow rating ' . num($m['max_flow_gpm']) . " gpm vs $flow gpm"); $util[] = $flow / num($m['max_flow_gpm']); }
        $conflicts = [];
        if ($start && $end) {
            foreach ($pms as $p) {
                if (($p['machine_id'] ?? null) === $m['id'] && plan_open($p['status'] ?? null) && overlap($p['start_date'], $p['end_date'], $start, $end)) {
                    $conflicts[] = (truthy($p['pm_type'] ?? null) ? $p['pm_type'] : 'PM') . " {$p['start_date']} to {$p['end_date']}" . (truthy($p['description'] ?? null) ? " ({$p['description']})" : '');
                }
            }
            foreach ($projects as $p) {
                if (($p['machine_id'] ?? null) === $m['id'] && plan_open($p['status'] ?? null) && overlap($p['start_date'], $p['end_date'], $start, $end)) $conflicts[] = "Deployed on {$p['code']} {$p['start_date']} to {$p['end_date']}";
            }
            foreach ($busy as $b) if (($b['machine_id'] ?? null) === $m['id'] && overlap($b['start'], $b['end'], $start, $end)) $conflicts[] = "Allocated in this run {$b['start']} to {$b['end']}";
        }
        // Best fit = capable machine loaded closest to 85% of its rating (not undersized, not wastefully oversized).
        $load = $util ? array_sum($util) / count($util) : 0.85;
        $score = $failed ? 0 : max(1, (int) round(100 - abs(0.85 - $load) * 70 - ($conflicts ? 35 : 0)));
        $manuals = [];
        foreach ($docs as $d) {
            $match = ($d['machine_id'] ?? null) === $m['id'];
            if (!$match && empty($d['machine_id'])) foreach (plan_codes($d['api_code'] ?? '') as $c) if (in_array($c, $mc, true)) { $match = true; break; }
            if ($match) $manuals[] = ['id' => $d['id'], 'title' => $d['title'] ?? null, 'doc_type' => $d['doc_type'] ?? null, 'has_file' => !empty($d['storage_path'])];
        }
        $ranked[] = ['machine' => $m, 'eligible' => !$failed, 'available' => !$conflicts, 'score' => $score, 'load_pct' => (int) round($load * 100),
            'pass' => $pass, 'failed' => $failed, 'conflicts' => $conflicts, 'manuals' => $manuals];
    }
    usort($ranked, fn($x, $y) => ((int) $y['eligible'] <=> (int) $x['eligible']) ?: ($y['score'] <=> $x['score']));
    $best = null;
    foreach ($ranked as $r) if ($r['eligible'] && $r['available']) { $best = $r; break; }
    return ['ranked' => $ranked, 'standards' => $standards, 'best' => $best];
}

/** Pull confirmed sales orders into the master schedule. */
function plan_generate_mps(): array
{
    $orders = Db::list('sales_orders', ['status' => 'confirmed']);
    $have = array_flip(array_filter(array_column(Db::list('mps_lines'), 'so_id')));
    $rows = [];
    foreach (array_filter($orders, fn($o) => !isset($have[$o['id']])) as $o) {
        $start = truthy($o['requested_start'] ?? null) ? $o['requested_start'] : add_days(today(), 14);
        $sel = plan_select_machine(['api_code' => $o['api_code'] ?? null, 'depth_ft' => $o['target_depth_ft'] ?? null, 'flow_gpm' => $o['target_flow_gpm'] ?? null,
            'operation' => $o['operation'] ?? null, 'start' => $start, 'end' => add_days($start, 30)]);
        $rows[] = ['so_id' => $o['id'], 'well_id' => $o['well_id'] ?? null, 'operation' => $o['operation'] ?? null, 'api_code' => $o['api_code'] ?? null,
            'depth_ft' => $o['target_depth_ft'] ?? null, 'flow_gpm' => $o['target_flow_gpm'] ?? null, 'start_date' => $start,
            'machine_id' => $sel['best']['machine']['id'] ?? null, 'status' => 'draft'];
    }
    Db::insertMany('mps_lines', $rows);
    return ['created' => count($rows)];
}

function plan_emp_blocks(string $id, $start, $end, array $ctx): array
{
    $out = [];
    foreach ($ctx['leaves'] as $l) {
        if (($l['employee_id'] ?? null) === $id && ($l['status'] ?? '') === 'approved' && overlap($l['start_date'], $l['end_date'], $start, $end))
            $out[] = ['kind' => 'leave', 'from' => $l['start_date'], 'to' => $l['end_date'], 'text' => ($l['leave_type'] ?? '') . ' leave'];
    }
    foreach ($ctx['trainings'] as $t) {
        if (($t['employee_id'] ?? null) === $id && in_array($t['status'] ?? '', ['planned', 'confirmed'], true) && overlap($t['start_date'], $t['end_date'], $start, $end))
            $out[] = ['kind' => 'training', 'from' => $t['start_date'], 'to' => $t['end_date'], 'text' => $ctx['C'][$t['course_id'] ?? '']['name'] ?? 'Training'];
    }
    foreach ($ctx['manning'] as $m) {
        if (($m['employee_id'] ?? null) === $id && plan_open($ctx['P'][$m['project_id'] ?? '']['status'] ?? null) && overlap($m['start_date'], $m['end_date'], $start, $end))
            $out[] = ['kind' => 'project', 'from' => $m['start_date'], 'to' => $m['end_date'], 'text' => $ctx['P'][$m['project_id'] ?? '']['code'] ?? 'Project'];
    }
    return $out;
}

/** Availability board for people and machines. */
function plan_availability($start, $end): array
{
    $emps = Db::list('employees');
    $leaves = Db::list('leaves');
    $trainings = Db::list('training_schedules');
    $manning = Db::list('project_manning');
    $machines = Db::list('machines');
    $pms = Db::list('maintenance_plans');
    $projects = Db::list('projects');
    $ctx = ['leaves' => $leaves, 'trainings' => $trainings, 'manning' => $manning, 'P' => by_id($projects), 'C' => by_id(Db::list('training_courses'))];
    $people = [];
    foreach (array_filter($emps, fn($e) => ($e['status'] ?? '') !== 'inactive') as $e)
        $people[] = ['id' => $e['id'], 'name' => $e['name'], 'position' => $e['position'] ?? null, 'blocks' => plan_emp_blocks($e['id'], $start, $end, $ctx)];
    $fleet = [];
    foreach (array_filter($machines, fn($m) => ($m['status'] ?? '') !== 'retired') as $m) {
        $blocks = [];
        foreach ($pms as $p) if (($p['machine_id'] ?? null) === $m['id'] && plan_open($p['status'] ?? null) && overlap($p['start_date'], $p['end_date'], $start, $end))
            $blocks[] = ['kind' => 'maintenance', 'from' => $p['start_date'], 'to' => $p['end_date'], 'text' => truthy($p['description'] ?? null) ? $p['description'] : ($p['pm_type'] ?? null)];
        foreach ($projects as $p) if (($p['machine_id'] ?? null) === $m['id'] && plan_open($p['status'] ?? null) && overlap($p['start_date'], $p['end_date'], $start, $end))
            $blocks[] = ['kind' => 'project', 'from' => $p['start_date'], 'to' => $p['end_date'], 'text' => $p['code'] ?? null];
        $fleet[] = ['id' => $m['id'], 'name' => ($m['code'] ?? '') . ' ' . ($m['name'] ?? ''), 'operation' => $m['operation'] ?? null, 'blocks' => $blocks];
    }
    return ['start' => $start, 'end' => $end, 'people' => $people, 'fleet' => $fleet];
}

function plan_iso(int $ts): string { return gmdate('Y-m-d\TH:i:s', $ts) . '.000Z'; }

/** MRP run over all firmed MPS lines. */
function plan_run_mrp(array $user): array
{
    $lines = Db::list('mps_lines', ['status' => 'firmed']);
    usort($lines, fn($a, $b) => strcmp((string) $a['start_date'], (string) $b['start_date']));
    if (!$lines) fail(400, 'No firmed Master Schedule lines to plan. Firm at least one MPS line first.');
    $T = [];
    foreach (['items', 'activity_templates', 'material_templates', 'crew_templates', 'kpi_templates', 'employees', 'leaves', 'training_schedules', 'project_manning', 'projects', 'wells', 'sales_orders', 'customers', 'training_courses'] as $t) $T[$t] = Db::list($t);
    $I = by_id($T['items']);
    $W = by_id($T['wells']);
    $P = by_id($T['projects']);
    $C = by_id($T['training_courses']);
    $SO = by_id($T['sales_orders']);
    $allocated = [];
    $busyEmp = [];
    $busyMach = [];
    $plans = [];

    foreach ($lines as $line) {
        $depth = num($line['depth_ft'] ?? 0);
        $k = $depth / 1000;
        $exceptions = [];
        // Activities with timeline in days and hours (24-hour operations, starting 06:00)
        $cursor = strtotime($line['start_date'] . 'T06:00:00Z');
        $acts = array_values(array_filter($T['activity_templates'], fn($a) => ($a['operation'] ?? null) === $line['operation']));
        usort($acts, fn($a, $b) => num($a['seq'] ?? 0) <=> num($b['seq'] ?? 0));
        $activities = [];
        foreach ($acts as $a) {
            $hours = (int) max(1, round(num($a['base_hours'] ?? 0) + num($a['hours_per_1000ft'] ?? 0) * $k));
            $activities[] = ['seq' => $a['seq'] ?? null, 'name' => $a['name'] ?? null, 'planned_hours' => $hours, 'planned_start' => plan_iso($cursor), 'planned_end' => plan_iso($cursor + $hours * 3600)];
            $cursor += $hours * 3600;
        }
        if (!$activities) $exceptions[] = "No activity template for operation \"{$line['operation']}\"";
        $total_hours = array_sum(array_column($activities, 'planned_hours'));
        $end_date = gmdate('Y-m-d', $cursor);
        $days = max(1, (int) ceil($total_hours / 24));

        // Machine: preferred if capable and free, else best alternative (checks PM plans and other deployments)
        $sel = plan_select_machine(['api_code' => $line['api_code'] ?? null, 'depth_ft' => $depth, 'flow_gpm' => $line['flow_gpm'] ?? null, 'operation' => $line['operation'],
            'start' => $line['start_date'], 'end' => $end_date, 'busy' => $busyMach]);
        $pref = null;
        foreach ($sel['ranked'] as $r) if ($r['machine']['id'] === ($line['machine_id'] ?? null)) { $pref = $r; break; }
        $pick = $pref && $pref['eligible'] && $pref['available'] ? $pref : $sel['best'];
        if ($pref && $pick && $pick['machine']['id'] !== $pref['machine']['id'])
            $exceptions[] = "Preferred machine {$pref['machine']['code']} not usable (" . implode('; ', array_merge($pref['failed'], $pref['conflicts'])) . "). Switched to {$pick['machine']['code']}.";
        if (!$pick) $exceptions[] = "No capable machine available {$line['start_date']} to $end_date. Rental/purchase requisition will be raised.";
        if ($pick) $busyMach[] = ['machine_id' => $pick['machine']['id'], 'start' => $line['start_date'], 'end' => $end_date];
        $machine = $pick ? ['id' => $pick['machine']['id'], 'code' => $pick['machine']['code'] ?? null, 'name' => $pick['machine']['name'] ?? null,
            'accessories' => $pick['machine']['accessories'] ?? null, 'day_rate' => num($pick['machine']['day_rate'] ?? 0), 'score' => $pick['score']] : null;

        // Materials, supplies and tools: gross requirement -> stock allocation -> net shortage -> order-by date from lead time
        $materials = [];
        foreach ($T['material_templates'] as $m) {
            if (($m['operation'] ?? null) !== $line['operation'] || !isset($I[$m['item_id'] ?? ''])) continue;
            $it = $I[$m['item_id']];
            $required = (int) ceil(num($m['base_qty'] ?? 0) + num($m['qty_per_1000ft'] ?? 0) * $k);
            $free = max(0, num($it['on_hand'] ?? 0) - num($it['safety_stock'] ?? 0) - ($allocated[$it['id']] ?? 0));
            $from_stock = min($required, $free);
            $short = $required - $from_stock;
            $allocated[$it['id']] = ($allocated[$it['id']] ?? 0) + $from_stock;
            $order_qty = $short ? max($short, num($it['min_order_qty'] ?? 0)) : 0;
            $order_by = $short ? add_days($line['start_date'], -(int) num($it['lead_time_days'] ?? 0)) : null;
            if ($short && $order_by < today()) $exceptions[] = "{$it['name']}: lead time " . num($it['lead_time_days'] ?? 0) . "d means ordering was due $order_by - expedite.";
            $materials[] = ['item_id' => $it['id'], 'code' => $it['code'] ?? null, 'name' => $it['name'] ?? null, 'category' => $it['category'] ?? null, 'uom' => $it['uom'] ?? null,
                'required' => $required, 'from_stock' => $from_stock, 'short' => $short, 'order_qty' => $order_qty, 'order_by' => $order_by, 'need_date' => $line['start_date'], 'unit_cost' => num($it['unit_cost'] ?? 0)];
        }

        // Field manning: by position, validated against leaves, trainings and other project assignments
        $crew = [];
        $ctx = ['leaves' => $T['leaves'], 'trainings' => $T['training_schedules'], 'manning' => $T['project_manning'], 'P' => $P, 'C' => $C];
        foreach (array_filter($T['crew_templates'], fn($c) => ($c['operation'] ?? null) === $line['operation']) as $ct) {
            for ($i = 0; $i < num($ct['qty'] ?? 0); $i++) {
                $blocked = [];
                $emp = null;
                foreach ($T['employees'] as $e) {
                    if (($e['position'] ?? null) !== $ct['position'] || ($e['status'] ?? '') === 'inactive') continue;
                    $why = array_map(fn($b) => "{$b['text']} {$b['from']} to {$b['to']}", plan_emp_blocks($e['id'], $line['start_date'], $end_date, $ctx));
                    foreach ($busyEmp as $b) if ($b['employee_id'] === $e['id'] && overlap($b['start'], $b['end'], $line['start_date'], $end_date)) $why[] = 'allocated in this run';
                    if ($why) { $blocked[] = "{$e['name']}: {$why[0]}"; continue; }
                    $emp = $e;
                    break;
                }
                if ($emp) $busyEmp[] = ['employee_id' => $emp['id'], 'start' => $line['start_date'], 'end' => $end_date];
                $crew[] = ['position' => $ct['position'], 'employee_id' => $emp['id'] ?? null, 'name' => $emp['name'] ?? null, 'hourly_rate' => num($emp['hourly_rate'] ?? 0),
                    'status' => $emp ? 'assigned' : 'shortage', 'blocked' => $blocked];
            }
        }
        $gaps = array_filter($crew, fn($c) => !$c['employee_id']);
        if ($gaps) {
            $by = [];
            foreach ($gaps as $c) $by[$c['position']] = ($by[$c['position']] ?? 0) + 1;
            $exceptions[] = 'Manpower shortage: ' . implode(', ', array_map(fn($p, $n) => "$n x $p", array_keys($by), $by));
        }

        $so = $SO[$line['so_id'] ?? ''] ?? null;
        $well = $W[$line['well_id'] ?? ''] ?? null;
        $cost = ['labor' => r2(array_sum(array_map(fn($c) => $c['hourly_rate'] * 12 * $days, $crew))),
            'material' => r2(array_sum(array_map(fn($m) => $m['required'] * $m['unit_cost'], $materials))),
            'equipment' => r2(($machine['day_rate'] ?? 0) * $days)];
        $alts = [];
        foreach (array_slice(array_values(array_filter($sel['ranked'], fn($r) => $r['eligible'])), 0, 4) as $r)
            $alts[] = ['code' => $r['machine']['code'] ?? null, 'name' => $r['machine']['name'] ?? null, 'score' => $r['score'], 'available' => $r['available'], 'conflicts' => $r['conflicts']];
        $kpis = [];
        foreach ($T['kpi_templates'] as $kp) if (($kp['operation'] ?? null) === $line['operation'])
            $kpis[] = ['name' => $kp['name'] ?? null, 'target' => $kp['target'] ?? null, 'unit' => $kp['unit'] ?? null, 'direction' => $kp['direction'] ?? null, 'auto_key' => $kp['auto_key'] ?? null];
        $plan = ['mps_id' => $line['id'], 'so_id' => $line['so_id'] ?? null, 'customer_id' => ($so['customer_id'] ?? null) ?: ($well['customer_id'] ?? null) ?: null, 'well_id' => $line['well_id'] ?? null,
            'name' => ucfirst($line['operation']) . ' - ' . (truthy($well['name'] ?? null) ? $well['name'] : (truthy($so['so_no'] ?? null) ? $so['so_no'] : 'Well')),
            'operation' => $line['operation'], 'api_code' => $line['api_code'] ?? null, 'depth_ft' => $depth, 'flow_gpm' => num($line['flow_gpm'] ?? 0),
            'start_date' => $line['start_date'], 'end_date' => $end_date, 'total_hours' => $total_hours, 'duration' => intdiv($total_hours, 24) . 'd ' . ($total_hours % 24) . 'h',
            'machine' => $machine, 'machine_alternatives' => $alts, 'activities' => $activities, 'materials' => $materials, 'crew' => $crew, 'cost' => $cost,
            'budget' => r2($cost['labor'] + $cost['material'] + $cost['equipment']), 'kpis' => $kpis, 'exceptions' => $exceptions];
        $plan['training'] = hr_training_needs($plan);
        $plans[] = $plan;
    }

    // Reorder-level replenishment for stock items not already covered by a shortage line
    $shortIds = [];
    foreach ($plans as $p) foreach ($p['materials'] as $m) if ($m['short']) $shortIds[$m['item_id']] = true;
    $replenishment = [];
    foreach ($T['items'] as $it) {
        if (!(num($it['reorder_level'] ?? 0) > 0) || isset($shortIds[$it['id']]) || num($it['on_hand'] ?? 0) - ($allocated[$it['id']] ?? 0) > num($it['reorder_level'])) continue;
        $replenishment[] = ['item_id' => $it['id'], 'code' => $it['code'] ?? null, 'name' => $it['name'] ?? null, 'uom' => $it['uom'] ?? null,
            'projected' => num($it['on_hand'] ?? 0) - ($allocated[$it['id']] ?? 0), 'reorder_level' => num($it['reorder_level']),
            'order_qty' => max(num($it['reorder_qty'] ?? 0), num($it['min_order_qty'] ?? 0), 1), 'order_by' => today(), 'need_date' => add_days(today(), (int) num($it['lead_time_days'] ?? 0))];
    }

    return Db::insert('mrp_runs', ['run_no' => Db::nextNo('mrp_runs', 'run_no', 'MRP-'), 'run_date' => now_iso(), 'status' => 'draft',
        'result' => ['plans' => $plans, 'replenishment' => $replenishment, 'by' => $user['name']]]);
}

function plan_approve_mrp(string $id, array $user): array
{
    $run = Db::get('mrp_runs', $id) ?? fail(404, 'MRP run not found');
    if ($run['status'] !== 'draft') fail(400, 'Run is already ' . $run['status']);
    return Db::update('mrp_runs', $id, ['status' => 'approved', 'approved_by' => $user['name']]);
}

/** Firming turns the plan into live projects and triggers procurement + training generation. */
function plan_firm_mrp(string $id, array $user): array
{
    $run = Db::get('mrp_runs', $id) ?? fail(404, 'MRP run not found');
    if ($run['status'] !== 'approved') fail(400, 'Only an approved MRP run can be firmed');
    $result = $run['result'] ?? ['plans' => [], 'replenishment' => []];
    $reqs = [];
    foreach ($result['plans'] as $i => $plan) {
        $mps = !empty($plan['mps_id']) ? Db::get('mps_lines', $plan['mps_id']) : null;
        if (!$mps || $mps['status'] === 'planned') continue;
        $project = Db::insert('projects', ['code' => Db::nextNo('projects', 'code', 'PRJ-'), 'name' => $plan['name'], 'customer_id' => $plan['customer_id'], 'well_id' => $plan['well_id'], 'so_id' => $plan['so_id'],
            'operation' => $plan['operation'], 'machine_id' => $plan['machine']['id'] ?? null, 'start_date' => $plan['start_date'], 'end_date' => $plan['end_date'], 'status' => 'planned',
            'budget' => $plan['budget'], 'mrp_run_id' => $id]);
        $result['plans'][$i]['project_id'] = $project['id'];
        $result['plans'][$i]['project_code'] = $project['code'];
        Db::insertMany('project_activities', array_map(fn($a) => $a + ['project_id' => $project['id'], 'actual_hours' => 0, 'pct_complete' => 0, 'status' => 'pending'], $plan['activities']));
        Db::insertMany('project_materials', array_map(fn($m) => ['project_id' => $project['id'], 'item_id' => $m['item_id'], 'qty_required' => $m['required'], 'qty_issued' => 0, 'need_date' => $m['need_date']], $plan['materials']));
        Db::insertMany('project_manning', array_map(fn($c) => ['project_id' => $project['id'], 'position' => $c['position'], 'employee_id' => $c['employee_id'], 'start_date' => $plan['start_date'],
            'end_date' => $plan['end_date'], 'status' => $c['status']], $plan['crew']));
        Db::insertMany('project_kpis', array_map(fn($kp) => $kp + ['project_id' => $project['id']], $plan['kpis']));
        foreach (array_filter($plan['materials'], fn($m) => $m['short']) as $m)
            $reqs[] = ['item_id' => $m['item_id'], 'description' => $m['name'], 'qty' => $m['order_qty'], 'need_date' => $m['need_date'], 'order_by' => $m['order_by'], 'project_id' => $project['id'], 'mrp_run_id' => $id, 'reason' => 'MRP shortage', 'status' => 'open'];
        if (empty($plan['machine'])) $reqs[] = ['description' => "Machine for {$plan['operation']}: API " . (truthy($plan['api_code'] ?? null) ? $plan['api_code'] : 'n/a') . ", {$plan['depth_ft']} ft, {$plan['flow_gpm']} gpm ({$plan['start_date']} to {$plan['end_date']})",
            'qty' => 1, 'need_date' => $plan['start_date'], 'order_by' => today(), 'project_id' => $project['id'], 'mrp_run_id' => $id, 'reason' => 'machine requirement', 'status' => 'open'];
        Db::update('mps_lines', $mps['id'], ['status' => 'planned', 'mrp_run_id' => $id, 'machine_id' => $plan['machine']['id'] ?? $mps['machine_id'] ?? null]);
        if (!empty($plan['so_id'])) Db::update('sales_orders', $plan['so_id'], ['status' => 'planned']);
    }
    foreach ($result['replenishment'] ?? [] as $r)
        $reqs[] = ['item_id' => $r['item_id'], 'description' => $r['name'], 'qty' => $r['order_qty'], 'need_date' => $r['need_date'], 'order_by' => $r['order_by'], 'mrp_run_id' => $id, 'reason' => 'reorder level', 'status' => 'open'];
    Db::insertMany('requisitions', $reqs);
    Db::update('mrp_runs', $id, ['status' => 'firmed', 'firmed_by' => $user['name'], 'result' => $result]);
    $rfqs = proc_generate_rfqs($id);
    $training = hr_generate_training($id);
    Db::insertMany('notifications', [
        ['role' => 'procurement_manager', 'title' => "MRP {$run['run_no']} firmed", 'body' => count($reqs) . " requisitions and {$rfqs['created']} RFQs were generated.", 'kind' => 'info', 'ref_table' => 'mrp_runs', 'ref_id' => $id],
        ['role' => 'hr_head', 'title' => "MRP {$run['run_no']} firmed", 'body' => "{$training['created']} training sessions were scheduled for assigned crew.", 'kind' => 'info', 'ref_table' => 'mrp_runs', 'ref_id' => $id],
    ]);
    return ['projects' => array_values(array_filter(array_column($result['plans'], 'project_code'))), 'requisitions' => count($reqs), 'rfqs' => $rfqs['created'], 'training' => $training['created']];
}

function routes_planning(callable $route): void
{
    $route('POST', 'planning/select-machine', act([], fn($p, $b) => plan_select_machine($b)));
    $route('POST', 'planning/mps/generate', act(['planning'], fn() => plan_generate_mps()));
    $route('GET', 'planning/availability', act([], fn() => plan_availability($_GET['start'] ?? today(), $_GET['end'] ?? today())));
    $route('POST', 'planning/mrp/run', act(['planning'], fn($p, $b, $u) => plan_run_mrp($u)));
    $route('POST', 'planning/mrp/{id}/approve', act(['planning'], fn($p, $b, $u) => plan_approve_mrp($p['id'], $u)));
    $route('POST', 'planning/mrp/{id}/firm', act(['planning'], fn($p, $b, $u) => plan_firm_mrp($p['id'], $u)));
}
