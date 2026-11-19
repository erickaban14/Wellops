<?php
// Project operations: daily work tickets (online + offline sync), posting to timesheets/stock/costs,
// work-day limit alerts, planned-vs-actual project overview. Port of server/services/operations.js.

const TICKET_FIELDS = ['client_id', 'project_id', 'work_date', 'shift', 'supervisor_id', 'status', 'entry_mode', 'incidents', 'remarks', 'lines', 'crew', 'materials'];

/** Upsert a ticket. client_id makes offline re-sends idempotent. */
function ops_save_ticket(array $body, array $user): array
{
    if (empty($body['project_id']) || empty($body['work_date'])) fail(400, 'Project and work date are required');
    $existing = null;
    if (!empty($body['id'])) $existing = Db::get('work_tickets', (string) $body['id']);
    elseif (!empty($body['client_id'])) $existing = Db::list('work_tickets', ['client_id' => $body['client_id']])[0] ?? null;
    if (($existing['status'] ?? null) === 'approved') fail(400, 'Approved tickets cannot be changed');
    $row = [];
    foreach (TICKET_FIELDS as $f) if (array_key_exists($f, $body)) $row[$f] = $body[$f];
    if (!truthy($row['status'] ?? null)) $row['status'] = 'draft';
    if (!truthy($row['entry_mode'] ?? null)) $row['entry_mode'] = 'online';
    if ($row['entry_mode'] === 'offline') $row['synced_at'] = now_iso();
    if ($existing) {
        $ticket = Db::update('work_tickets', $existing['id'], $row);
    } else {
        $row['ticket_no'] = Db::nextNo('work_tickets', 'ticket_no', 'DWT-');
        $row['supervisor_id'] = truthy($row['supervisor_id'] ?? null) ? $row['supervisor_id'] : $user['employee_id'];
        $ticket = Db::insert('work_tickets', $row);
    }
    if ($ticket['status'] !== 'draft') ops_post_ticket($ticket);
    return $ticket;
}

function ops_approve_ticket(string $id, array $user): array
{
    if (!in_array($user['role'], ['rig_supervisor', 'rig_manager', 'operations_head', 'admin'], true)) fail(403, 'Only a supervisor or manager can approve work tickets');
    $t = Db::get('work_tickets', $id) ?? fail(404, 'Ticket not found');
    if ($t['status'] !== 'submitted') fail(400, 'Only submitted tickets can be approved');
    return Db::update('work_tickets', $id, ['status' => 'approved', 'remarks' => implode("\n", array_filter([$t['remarks'] ?? '', 'Approved by ' . $user['name']]))]);
}

/** Posting is idempotent: previous effects of this ticket are reversed, then re-applied. */
function ops_post_ticket(array $t): void
{
    $project = Db::get('projects', (string) $t['project_id']) ?? fail(400, 'Project not found');
    $E = by_id(Db::list('employees'));
    $I = by_id(Db::list('items'));
    $ref = $t['ticket_no'];
    $before = array_map(fn($i) => $i['on_hand'] ?? null, $I);

    Db::q('DELETE FROM `timesheets` WHERE ticket_id = ?', [$t['id']]);
    Db::q('DELETE FROM `project_costs` WHERE ref = ?', [$ref]);
    foreach (Db::list('stock_moves', ['ref' => $ref]) as $x) {
        if (isset($I[$x['item_id'] ?? ''])) $I[$x['item_id']]['on_hand'] = num($I[$x['item_id']]['on_hand'] ?? 0) + num($x['qty'] ?? 0);
        Db::remove('stock_moves', $x['id']);
    }

    // Timesheets + labour cost
    $dayHours = num(setting('regular_hours_per_day', 8));
    $otMult = num(setting('ot_multiplier', 1.25));
    $auto = (string) setting('auto_consolidate_online', 'true');
    $status = ($t['entry_mode'] ?? '') === 'online' && $auto === 'true' ? 'consolidated' : 'captured';
    $crew = array_values(array_filter($t['crew'] ?? [], fn($c) => !empty($c['employee_id']) && num($c['hours'] ?? 0) > 0));
    $labor = 0.0;
    $sheets = [];
    foreach ($crew as $c) {
        $reg = min(num($c['hours']), $dayHours);
        $ot = num($c['hours']) - $reg;
        $labor += ($reg + $ot * $otMult) * num($E[$c['employee_id']]['hourly_rate'] ?? 0);
        $sheets[] = ['employee_id' => $c['employee_id'], 'project_id' => $t['project_id'], 'work_date' => $t['work_date'], 'regular_hours' => $reg, 'ot_hours' => $ot,
            'source' => 'dwt', 'ticket_id' => $t['id'], 'status' => $status];
    }
    Db::insertMany('timesheets', $sheets);
    $costs = [];
    if ($labor) $costs[] = ['category' => 'labor', 'amount' => r2($labor), 'description' => "Crew labour $ref"];

    // Material issues
    $matCost = 0.0;
    foreach (array_filter($t['materials'] ?? [], fn($m) => !empty($m['item_id']) && num($m['qty'] ?? 0) > 0) as $m) {
        if (!isset($I[$m['item_id']])) continue;
        $I[$m['item_id']]['on_hand'] = num($I[$m['item_id']]['on_hand'] ?? 0) - num($m['qty']);
        $it = $I[$m['item_id']];
        Db::insert('stock_moves', ['move_date' => now_iso(), 'move_type' => 'issue', 'item_id' => $it['id'], 'qty' => num($m['qty']), 'unit_cost' => num($it['unit_cost'] ?? 0),
            'project_id' => $t['project_id'], 'ref' => $ref, 'qa_status' => 'n/a', 'remarks' => 'Consumed on work ticket']);
        $matCost += num($m['qty']) * num($it['unit_cost'] ?? 0);
    }
    foreach ($I as $id => $it) if (($it['on_hand'] ?? null) !== $before[$id]) Db::update('items', $id, ['on_hand' => $it['on_hand']]);
    if ($matCost) {
        $costs[] = ['category' => 'material', 'amount' => r2($matCost), 'description' => "Materials consumed $ref"];
        journal($t['work_date'], $ref, 'Materials consumed', [['5000', $matCost, 0], ['1300', 0, $matCost]], $t['project_id']);
    }

    // Machine day rate: once per project per day
    if (!empty($project['machine_id'])) {
        $dayRef = 'DAYRATE ' . $t['work_date'];
        $have = count(Db::list('project_costs', ['project_id' => $t['project_id'], 'ref' => $dayRef]));
        $rate = num((Db::get('machines', $project['machine_id']) ?? [])['day_rate'] ?? 0);
        if (!$have && $rate) Db::insert('project_costs', ['project_id' => $t['project_id'], 'cost_date' => $t['work_date'], 'category' => 'equipment', 'amount' => $rate,
            'description' => 'Machine day rate', 'ref' => $dayRef]);
    }
    Db::insertMany('project_costs', array_map(fn($c) => $c + ['project_id' => $t['project_id'], 'cost_date' => $t['work_date'], 'ref' => $ref], $costs));
    if (($project['status'] ?? '') === 'planned') {
        Db::update('projects', $project['id'], ['status' => 'active']);
        if (!empty($project['machine_id'])) Db::update('machines', $project['machine_id'], ['status' => 'deployed']);
        if (!empty($project['so_id'])) Db::update('sales_orders', $project['so_id'], ['status' => 'in progress']);
    }
    ops_recalc_project($t['project_id']);
    $crewIds = array_column($crew, 'employee_id');
    if ($status === 'consolidated') hr_recalc_accumulated($crewIds);
    ops_check_work_limit($t, $crewIds, $E);
}

/** Activity actuals and issued quantities are always recomputed from source documents. */
function ops_recalc_project(string $project_id): void
{
    $tickets = array_filter(Db::list('work_tickets', ['project_id' => $project_id]), fn($t) => $t['status'] !== 'draft');
    usort($tickets, fn($a, $b) => strcmp((string) $a['work_date'], (string) $b['work_date']));
    $lines = [];
    foreach ($tickets as $t) foreach ($t['lines'] ?? [] as $l) $lines[] = $l;
    foreach (Db::list('project_activities', ['project_id' => $project_id]) as $a) {
        $mine = array_values(array_filter($lines, fn($l) => ($l['activity_id'] ?? null) === $a['id']));
        if (!$mine && !num($a['actual_hours'] ?? 0)) continue;
        $hours = r2(sum($mine, 'hours'));
        $pcts = array_values(array_filter(array_map(fn($l) => num($l['pct_complete'] ?? 0), $mine)));
        $ph = num($a['planned_hours'] ?? 0);
        $pct = min(100, $pcts ? max($pcts) : ($hours ? min(95, $ph ? round($hours / $ph * 100) : 95) : 0));
        Db::update('project_activities', $a['id'], ['actual_hours' => $hours, 'pct_complete' => $pct, 'status' => $pct >= 100 ? 'done' : ($hours ? 'in progress' : 'pending')]);
    }
    $moves = Db::list('stock_moves', ['project_id' => $project_id]);
    foreach (Db::list('project_materials', ['project_id' => $project_id]) as $m) {
        $issued = sum(array_filter($moves, fn($x) => ($x['item_id'] ?? null) === ($m['item_id'] ?? null)),
            fn($x) => $x['move_type'] === 'issue' ? num($x['qty']) : ($x['move_type'] === 'return in' ? -num($x['qty']) : 0));
        if ($issued !== num($m['qty_issued'] ?? 0)) Db::update('project_materials', $m['id'], ['qty_issued' => $issued]);
    }
}

/** Alert the Rig Manager when someone works beyond the maximum consecutive days (setting max_work_days, default 15). */
function ops_check_work_limit(array $t, array $empIds, array $E): void
{
    $empIds = array_values(array_unique($empIds));
    if (!$empIds) return;
    $limit = num(setting('max_work_days', 15));
    $in = implode(',', array_fill(0, count($empIds), '?'));
    $by = [];
    foreach (Db::raw("SELECT employee_id, work_date FROM `timesheets` WHERE employee_id IN ($in)", $empIds) as $r) $by[$r['employee_id']][] = $r['work_date'];
    $alerts = Db::list('work_limit_alerts');
    foreach ($empIds as $id) {
        $days = hr_streak($by[$id] ?? [], $t['work_date']);
        if ($days <= $limit) continue;
        $skip = false;
        foreach ($alerts as $a) {
            if (($a['employee_id'] ?? null) !== $id) continue;
            if ($a['status'] === 'pending' || ($a['status'] === 'approved' && ($a['as_of'] ?? '') >= $t['work_date'])) { $skip = true; break; }
        }
        if ($skip) continue;
        $alert = Db::insert('work_limit_alerts', ['employee_id' => $id, 'project_id' => $t['project_id'], 'as_of' => $t['work_date'], 'consecutive_days' => $days, 'limit_days' => $limit, 'status' => 'pending']);
        notify('rig_manager', 'Work-day limit exceeded', ($E[$id]['name'] ?? '') . " has worked $days consecutive days (limit $limit). Approval required to continue.",
            ['kind' => 'approval', 'ref_table' => 'work_limit_alerts', 'ref_id' => $alert['id']]);
    }
}

function ops_decide_alert(string $id, bool $approve, array $user, $note): array
{
    $a = Db::get('work_limit_alerts', $id) ?? fail(404, 'Alert not found');
    if ($a['status'] !== 'pending') fail(400, 'Alert already decided');
    if (!in_array($user['role'], ['rig_manager', 'operations_head', 'admin'], true)) fail(403, 'Only the Rig Manager can decide work-limit approvals');
    if (!$approve && trim((string) $note) === '') fail(400, 'A reason is required when rejecting');
    return Db::update('work_limit_alerts', $id, ['status' => $approve ? 'approved' : 'rejected', 'decided_by' => $user['name'], 'decided_at' => now_iso(), 'decision_note' => $note ?: '']);
}

function ops_ts($s): float { return $s ? (float) strtotime((string) $s) : 0.0; }

/**
 * Planned vs actual, exceptions, KPIs and accumulated cost for one project.
 * $pre (optional): fn(string $table): array of preloaded rows, used by the dashboard to avoid repeated queries.
 */
function ops_overview(string $project_id, ?callable $pre = null): array
{
    $get = function (string $t) use ($pre, $project_id) {
        return $pre ? array_values(array_filter($pre($t), fn($r) => ($r['project_id'] ?? null) === $project_id)) : Db::list($t, ['project_id' => $project_id]);
    };
    $project = $pre ? (array_values(array_filter($pre('projects'), fn($p) => $p['id'] === $project_id))[0] ?? null) : Db::get('projects', $project_id);
    if (!$project) fail(404, 'Project not found');
    $activities = $get('project_activities');
    $materials = $get('project_materials');
    $manning = $get('project_manning');
    $kpis = $get('project_kpis');
    $costs = $get('project_costs');
    $tickets = $get('work_tickets');
    $alerts = $get('work_limit_alerts');
    usort($activities, fn($a, $b) => num($a['seq'] ?? 0) <=> num($b['seq'] ?? 0));

    $t0 = (float) time();
    $totalH = sum($activities, 'planned_hours') ?: 1;
    $span = fn($a) => (ops_ts($a['planned_end'] ?? null) - ops_ts($a['planned_start'] ?? null)) ?: 0.001;
    $frac = fn($a, $at) => max(0, min(1, ($at - ops_ts($a['planned_start'] ?? null)) / $span($a)));
    $planned_pct = (int) round(sum($activities, fn($a) => num($a['planned_hours'] ?? 0) * $frac($a, $t0)) / $totalH * 100);
    $actual_pct = (int) round(sum($activities, fn($a) => num($a['planned_hours'] ?? 0) * num($a['pct_complete'] ?? 0) / 100) / $totalH * 100);
    $posted = array_values(array_filter($tickets, fn($t) => $t['status'] !== 'draft'));
    $lines = [];
    foreach ($posted as $t) foreach ($t['lines'] ?? [] as $l) $lines[] = $l;
    $hours = sum($lines, 'hours');
    $npt = sum(array_filter($lines, fn($l) => !empty($l['npt'])), 'hours');
    $cost = r2(sum($costs, 'amount'));
    $budget = num($project['budget'] ?? 0);
    $earned = $budget * $actual_pct / 100;
    $footage = sum($lines, fn($l) => max(0, num($l['depth_to'] ?? 0) - num($l['depth_from'] ?? 0)));
    $drillH = sum(array_filter($lines, fn($l) => num($l['depth_to'] ?? 0) > num($l['depth_from'] ?? 0)), 'hours');
    $auto = ['npt_pct' => $hours ? r2($npt / $hours * 100) : 0, 'cost_var_pct' => $earned ? r2(($cost - $earned) / $earned * 100) : 0, 'schedule_var_pct' => $actual_pct - $planned_pct,
        'incidents' => sum($posted, 'incidents'), 'rop' => $drillH ? r2($footage / $drillH) : null];
    $kpiRows = array_map(function ($k) use ($auto) {
        $actual = !empty($k['auto_key']) && ($auto[$k['auto_key']] ?? null) !== null ? $auto[$k['auto_key']] : ($k['actual'] ?? null);
        $ok = ($actual === null || $actual === '') ? null : (($k['direction'] ?? '') === 'at least' ? num($actual) >= num($k['target'] ?? 0) : num($actual) <= num($k['target'] ?? 0));
        return array_merge($k, ['actual' => $actual, 'ok' => $ok]);
    }, $kpis);

    $ex = [];
    if (($project['status'] ?? '') !== 'completed') {
        foreach ($activities as $a) {
            $name = $a['name'] ?? '';
            if (ops_ts($a['planned_end'] ?? null) < $t0 && num($a['pct_complete'] ?? 0) < 100) $ex[] = ['level' => 'high', 'type' => 'Schedule', 'text' => "\"$name\" should be complete (" . num($a['pct_complete'] ?? 0) . '% done)'];
            elseif (ops_ts($a['planned_start'] ?? null) < $t0 && !num($a['actual_hours'] ?? 0) && num($a['pct_complete'] ?? 0) < 100) $ex[] = ['level' => 'medium', 'type' => 'Schedule', 'text' => "\"$name\" has not started"];
            if (num($a['actual_hours'] ?? 0) > num($a['planned_hours'] ?? 0) * 1.1) $ex[] = ['level' => 'medium', 'type' => 'Hours', 'text' => "\"$name\" used " . num($a['actual_hours']) . 'h vs ' . num($a['planned_hours'] ?? 0) . 'h planned'];
        }
        if ($budget && $cost > $budget) $ex[] = ['level' => 'high', 'type' => 'Cost', 'text' => 'Cost ' . fmt_num($cost) . ' exceeds budget ' . fmt_num($budget)];
        elseif ($earned && $cost > $earned * 1.1) $ex[] = ['level' => 'medium', 'type' => 'Cost', 'text' => 'Cost is ' . (int) round(($cost / $earned - 1) * 100) . '% above earned value'];
        if ($npt) $ex[] = ['level' => $npt / $hours > 0.05 ? 'high' : 'low', 'type' => 'NPT', 'text' => "{$npt}h non-productive time ({$auto['npt_pct']}%)"];
        if ($auto['incidents']) $ex[] = ['level' => 'high', 'type' => 'HSE', 'text' => $auto['incidents'] . ' incident(s) reported'];
        $gaps = count(array_filter($manning, fn($m) => ($m['status'] ?? '') === 'shortage'));
        if ($gaps) $ex[] = ['level' => 'medium', 'type' => 'Manning', 'text' => "$gaps crew position(s) unfilled"];
        foreach ($materials as $m) {
            if (num($m['qty_issued'] ?? 0) > num($m['qty_required'] ?? 0)) $ex[] = ['level' => 'low', 'type' => 'Material', 'text' => 'Material over-issued: ' . num($m['qty_issued'] ?? 0) . ' vs ' . num($m['qty_required'] ?? 0) . ' planned', 'item_id' => $m['item_id'] ?? null];
        }
        $pend = count(array_filter($alerts, fn($a) => ($a['status'] ?? '') === 'pending'));
        if ($pend) $ex[] = ['level' => 'high', 'type' => 'Work limit', 'text' => "$pend work-day limit approval(s) pending"];
        if (($project['status'] ?? '') === 'planned' && ($project['start_date'] ?? '9999') < today()) $ex[] = ['level' => 'medium', 'type' => 'Schedule', 'text' => 'Planned start date has passed with no work ticket'];
    }

    // Day-by-day trend: planned vs actual progress (%) and cumulative cost vs planned spend.
    $trend = [];
    if ($activities && !empty($project['start_date'])) {
        $last = min(today(), $project['end_date'] ?? today());
        $sorted = $posted;
        usort($sorted, fn($a, $b) => strcmp((string) $a['work_date'], (string) $b['work_date']));
        for ($d = $project['start_date']; $d <= $last && count($trend) < 120; $d = add_days($d, 1)) {
            $at = (float) strtotime($d . 'T23:59:59Z');
            $plannedD = (int) round(sum($activities, fn($a) => num($a['planned_hours'] ?? 0) * $frac($a, $at)) / $totalH * 100);
            $dayLines = [];
            foreach ($sorted as $t) if ($t['work_date'] <= $d) foreach ($t['lines'] ?? [] as $l) $dayLines[] = $l;
            $actualD = (int) round(sum($activities, function ($a) use ($dayLines) {
                $mine = array_values(array_filter($dayLines, fn($l) => ($l['activity_id'] ?? null) === $a['id']));
                if (!$mine) return 0;
                $pcts = array_values(array_filter(array_map(fn($l) => num($l['pct_complete'] ?? 0), $mine)));
                $ph = num($a['planned_hours'] ?? 0);
                $p = $pcts ? max($pcts) : ($ph ? min(95, sum($mine, 'hours') / $ph * 100) : 95);
                return $ph * min(100, $p) / 100;
            }) / $totalH * 100);
            $trend[] = ['date' => $d, 'planned' => $plannedD, 'actual' => $actualD,
                'cost' => r2(sum(array_filter($costs, fn($c) => ($c['cost_date'] ?? '9999') <= $d), 'amount')), 'planned_cost' => (int) round($budget * $plannedD / 100)];
        }
    }
    $byCat = [];
    foreach (group_by($costs, 'category') as $k => $v) $byCat[$k] = r2(sum($v, 'amount'));
    return ['project' => $project, 'activities' => $activities, 'materials' => $materials, 'manning' => $manning, 'kpis' => $kpiRows, 'tickets' => count($posted),
        'planned_pct' => $planned_pct, 'actual_pct' => $actual_pct, 'deviation' => $actual_pct - $planned_pct, 'cost' => $cost, 'budget' => $budget,
        'cost_by_category' => $byCat ?: new stdClass(), 'hours' => $hours, 'npt' => $npt, 'exceptions' => $ex, 'trend' => $trend];
}

function routes_operations(callable $route): void
{
    $route('POST', 'operations/tickets', act(['operations'], fn($p, $b, $u) => ops_save_ticket($b, $u)));
    $route('POST', 'operations/tickets/sync', function () {
        Auth::need('operations');
        $results = [];
        foreach (req_body()['tickets'] ?? [] as $t) {
            try {
                $saved = Db::tx(fn() => ops_save_ticket(array_merge($t, ['entry_mode' => 'offline']), Auth::$user));
                $results[] = ['client_id' => $t['client_id'] ?? null, 'ok' => true, 'ticket_no' => $saved['ticket_no']];
            } catch (Throwable $e) {
                $results[] = ['client_id' => $t['client_id'] ?? null, 'ok' => false, 'error' => $e instanceof HttpError || $e instanceof PDOException ? $e->getMessage() : 'Server error'];
            }
        }
        return ['results' => $results];
    });
    $route('POST', 'operations/tickets/{id}/approve', act(['operations'], fn($p, $b, $u) => ops_approve_ticket($p['id'], $u)));
    $route('GET', 'operations/projects/{id}/overview', fn($p) => ops_overview($p['id']));
    $route('POST', 'operations/alerts/{id}/decide', act([], fn($p, $b, $u) => ops_decide_alert($p['id'], !empty($b['approve']), $u, $b['note'] ?? '')));
}
