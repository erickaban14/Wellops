<?php
// HR: training compliance + MRP-driven scheduling, timekeeping consolidation, payroll (port of server/services/hr.js).

function hr_latest(array $records, $emp, $course): ?array
{
    $mine = array_values(array_filter($records, fn($r) => ($r['employee_id'] ?? null) === $emp && ($r['course_id'] ?? null) === $course));
    usort($mine, fn($a, $b) => strcmp((string) ($b['completed_date'] ?? ''), (string) ($a['completed_date'] ?? '')));
    return $mine[0] ?? null;
}
function hr_required_for(array $matrix, $position): array
{
    $ids = [];
    foreach ($matrix as $m) if (($m['position'] ?? null) === 'All Personnel' || ($m['position'] ?? null) === $position) $ids[$m['course_id']] = true;
    return array_keys($ids);
}

/** Courses each assigned crew member is missing (or that expire before the project ends). */
function hr_training_needs(array $plan): array
{
    $matrix = Db::list('training_matrix');
    $records = Db::list('training_records');
    $C = by_id(Db::list('training_courses'));
    $E = by_id(Db::list('employees'));
    $needs = [];
    foreach (array_filter($plan['crew'] ?? [], fn($c) => !empty($c['employee_id'])) as $c) {
        foreach (hr_required_for($matrix, $E[$c['employee_id']]['position'] ?? null) as $cid) {
            $rec = hr_latest($records, $c['employee_id'], $cid);
            if ($rec && (!truthy($rec['expiry_date'] ?? null) || $rec['expiry_date'] >= $plan['end_date'])) continue;
            if (isset($C[$cid])) {
                $needs[] = ['employee_id' => $c['employee_id'], 'name' => $c['name'] ?? null, 'course_id' => $cid, 'course' => $C[$cid]['name'], 'pillar' => $C[$cid]['pillar'] ?? null,
                    'duration_days' => num($C[$cid]['duration_days'] ?? 0) ?: 1,
                    'reason' => $rec ? 'Certificate expires ' . $rec['expiry_date'] : 'No valid certificate'];
            }
        }
    }
    return $needs;
}

/** Generate training schedules from an approved and firmed MRP run. */
function hr_generate_training($runId): array
{
    $run = ($runId ? Db::get('mrp_runs', (string) $runId) : null) ?? fail(404, 'MRP run not found');
    if ($run['status'] !== 'firmed') fail(400, 'Training schedules are generated from an approved and firmed MRP run');
    $schedules = Db::list('training_schedules');
    $leaves = Db::list('leaves');
    $rows = [];
    $isDup = fn($n) => function ($s) use ($n) {
        return ($s['employee_id'] ?? null) === $n['employee_id'] && ($s['course_id'] ?? null) === $n['course_id'] && in_array($s['status'] ?? '', ['planned', 'confirmed'], true);
    };
    foreach ($run['result']['plans'] ?? [] as $plan) {
        foreach (hr_training_needs($plan) as $n) {
            $dup = $isDup($n);
            if (array_filter($schedules, $dup) || array_filter($rows, $dup)) continue;
            // Latest slot that finishes 2 days before mobilisation, moved earlier around approved leave.
            $end = add_days($plan['start_date'], -2);
            $start = add_days($end, -($n['duration_days'] - 1));
            $note = $n['reason'];
            $onLeave = function () use (&$start, &$end, $leaves, $n) {
                foreach ($leaves as $l) {
                    if (($l['employee_id'] ?? null) === $n['employee_id'] && ($l['status'] ?? '') === 'approved' && overlap($l['start_date'], $l['end_date'], $start, $end)) return true;
                }
                return false;
            };
            for ($i = 0; $i < 45 && $onLeave() && $start > add_days(today(), 1); $i++) { $start = add_days($start, -1); $end = add_days($end, -1); }
            if ($start <= today()) {
                $start = add_days(today(), 1);
                $end = add_days($start, $n['duration_days'] - 1);
                if ($end >= $plan['start_date']) $note .= ' - cannot finish before mobilisation, expedite or reassign';
            }
            $rows[] = ['employee_id' => $n['employee_id'], 'course_id' => $n['course_id'], 'start_date' => $start, 'end_date' => $end, 'status' => 'planned',
                'source' => 'MRP ' . $run['run_no'], 'mrp_run_id' => $runId, 'project_id' => $plan['project_id'] ?? null, 'note' => $note];
        }
    }
    Db::insertMany('training_schedules', $rows);
    return ['created' => count($rows)];
}

/** Employee x course compliance grid for the training matrix page. */
function hr_compliance(): array
{
    $emps = Db::list('employees');
    $courses = Db::list('training_courses');
    $matrix = Db::list('training_matrix');
    $records = Db::list('training_records');
    $schedules = Db::list('training_schedules');
    $soon = add_days(today(), 60);
    $rows = [];
    foreach (array_filter($emps, fn($e) => ($e['status'] ?? '') !== 'inactive') as $e) {
        $req = hr_required_for($matrix, $e['position'] ?? null);
        $cells = [];
        foreach ($req as $cid) {
            $rec = hr_latest($records, $e['id'], $cid);
            $sch = null;
            foreach ($schedules as $s) if (($s['employee_id'] ?? null) === $e['id'] && ($s['course_id'] ?? null) === $cid && in_array($s['status'] ?? '', ['planned', 'confirmed'], true)) { $sch = $s; break; }
            $exp = $rec['expiry_date'] ?? null;
            $state = !$rec ? 'missing' : ($exp && $exp < today() ? 'expired' : ($exp && $exp <= $soon ? 'expiring' : 'valid'));
            if ($sch && $state !== 'valid') $state = 'scheduled';
            $cells[$cid] = ['state' => $state, 'expiry' => $exp, 'scheduled' => $sch['start_date'] ?? null];
        }
        $ok = count(array_filter($req, fn($c) => in_array($cells[$c]['state'], ['valid', 'expiring'], true)));
        $rows[] = ['id' => $e['id'], 'name' => $e['name'], 'position' => $e['position'] ?? null, 'cells' => $cells ?: new stdClass(),
            'pct' => $req ? (int) round($ok / count($req) * 100) : 100];
    }
    usort($courses, fn($a, $b) => strcasecmp((string) ($a['pillar'] ?? ''), (string) ($b['pillar'] ?? '')) ?: strcasecmp((string) ($a['code'] ?? ''), (string) ($b['code'] ?? '')));
    return ['courses' => $courses, 'rows' => $rows];
}

// ---- Timekeeping ----
function hr_recalc_accumulated(array $empIds): void
{
    $empIds = array_values(array_unique(array_filter($empIds)));
    if (!$empIds) return;
    $in = implode(',', array_fill(0, count($empIds), '?'));
    $agg = [];
    foreach (Db::raw("SELECT employee_id, SUM(COALESCE(regular_hours,0) + COALESCE(ot_hours,0)) AS h, COUNT(DISTINCT work_date) AS d FROM `timesheets`
        WHERE (status IS NULL OR status <> 'captured') AND employee_id IN ($in) GROUP BY employee_id", $empIds) as $r) $agg[$r['employee_id']] = $r;
    foreach ($empIds as $id) Db::update('employees', $id, ['accumulated_hours' => r2($agg[$id]['h'] ?? 0), 'accumulated_days' => (int) ($agg[$id]['d'] ?? 0)]);
}

function hr_consolidate(): array
{
    $pending = Db::raw("SELECT DISTINCT employee_id FROM `timesheets` WHERE status = 'captured'");
    $n = Db::q("UPDATE `timesheets` SET status = 'consolidated', updated_at = ? WHERE status = 'captured'", [Db::nowSql()])->rowCount();
    hr_recalc_accumulated(array_column($pending, 'employee_id'));
    return ['consolidated' => $n];
}

function hr_streak(array $dates, ?string $asOf): int
{
    $set = array_flip($dates);
    $n = 0;
    for ($d = $asOf; $d !== null && isset($set[$d]); $d = add_days($d, -1)) $n++;
    return $n;
}

function hr_time_summary($from, $to): array
{
    $emps = Db::list('employees');
    $limit = num(setting('max_work_days', 15));
    $by = [];
    foreach (Db::raw('SELECT employee_id, work_date, regular_hours, ot_hours, status FROM `timesheets` ORDER BY `_row`') as $t) $by[$t['employee_id']][] = $t;
    $out = [];
    foreach ($emps as $e) {
        if (empty($by[$e['id']])) continue;
        $all = $by[$e['id']];
        $rows = array_filter($all, fn($t) => (!$from || $t['work_date'] >= $from) && (!$to || $t['work_date'] <= $to));
        if (!$rows) continue;
        $dates = array_column($all, 'work_date');
        sort($dates);
        $last = end($dates);
        $out[] = ['id' => $e['id'], 'name' => $e['name'], 'position' => $e['position'] ?? null,
            'regular_hours' => r2(sum($rows, 'regular_hours')), 'ot_hours' => r2(sum($rows, 'ot_hours')),
            'days' => count(array_unique(array_column($rows, 'work_date'))),
            'unconsolidated' => count(array_filter($rows, fn($t) => $t['status'] === 'captured')),
            'last_worked' => $last, 'consecutive_days' => hr_streak($dates, $last)];
    }
    usort($out, fn($a, $b) => $b['consecutive_days'] <=> $a['consecutive_days']);
    return ['limit' => $limit, 'rows' => $out];
}

// ---- Payroll ----
function hr_run_payroll(array $b): array
{
    $ps = $b['period_start'] ?? '';
    $pe = $b['period_end'] ?? '';
    if (!$ps || !$pe || $pe < $ps) fail(400, 'Enter a valid pay period');
    $emps = Db::list('employees');
    $ts = Db::raw("SELECT employee_id, work_date, regular_hours, ot_hours FROM `timesheets` WHERE status = 'consolidated' AND work_date BETWEEN ? AND ?", [$ps, $pe]);
    $leaves = Db::list('leaves', ['status' => 'approved']);
    $otMult = num(setting('ot_multiplier', 1.25));
    $taxPct = num(setting('payroll_tax_pct', 10));
    $contribPct = num(setting('payroll_contribution_pct', 4.5));
    $dayHours = num(setting('regular_hours_per_day', 8));
    $inPeriod = group_by($ts, 'employee_id');
    $slips = [];
    foreach ($emps as $e) {
        $rows = $inPeriod[$e['id']] ?? [];
        $leave_days = 0.0;
        foreach ($leaves as $l) {
            if (($l['employee_id'] ?? null) !== $e['id'] || empty($l['paid']) || !overlap($l['start_date'], $l['end_date'], $ps, $pe)) continue;
            $leave_days += days_between($l['start_date'] > $ps ? $l['start_date'] : $ps, $l['end_date'] < $pe ? $l['end_date'] : $pe) + 1;
        }
        if (!$rows && !$leave_days) continue;
        $rate = num($e['hourly_rate'] ?? 0);
        $regular_hours = sum($rows, 'regular_hours');
        $ot_hours = sum($rows, 'ot_hours');
        $days_worked = count(array_unique(array_column($rows, 'work_date')));
        $basic_pay = r2($regular_hours * $rate);
        $ot_pay = r2($ot_hours * $rate * $otMult);
        $leave_pay = r2($leave_days * $dayHours * $rate);
        $allowances = r2($days_worked * num($e['daily_allowance'] ?? 0));
        $gross_pay = r2($basic_pay + $ot_pay + $leave_pay + $allowances);
        $deductions = r2($gross_pay * ($taxPct + $contribPct) / 100);
        $slips[] = ['employee_id' => $e['id'], 'days_worked' => $days_worked, 'regular_hours' => $regular_hours, 'ot_hours' => $ot_hours, 'leave_days' => $leave_days,
            'basic_pay' => $basic_pay, 'ot_pay' => $ot_pay, 'leave_pay' => $leave_pay, 'allowances' => $allowances, 'gross_pay' => $gross_pay,
            'deductions' => $deductions, 'net_pay' => r2($gross_pay - $deductions)];
    }
    if (!$slips) fail(400, 'No consolidated timesheets or paid leaves in this period. Consolidate timesheets first.');
    $run = Db::insert('payroll_runs', ['name' => "Payroll $ps to $pe", 'period_start' => $ps, 'period_end' => $pe, 'status' => 'draft',
        'total_gross' => r2(sum($slips, 'gross_pay')), 'total_net' => r2(sum($slips, 'net_pay'))]);
    Db::insertMany('payslips', array_map(fn($s) => $s + ['run_id' => $run['id']], $slips));
    return $run;
}

function hr_approve_payroll(string $id): array
{
    $run = Db::get('payroll_runs', $id) ?? fail(404, 'Payroll run not found');
    if ($run['status'] !== 'draft') fail(400, 'Payroll run already approved');
    $emp = array_values(array_unique(array_column(Db::list('payslips', ['run_id' => $id]), 'employee_id')));
    if ($emp) {
        $in = implode(',', array_fill(0, count($emp), '?'));
        Db::q("UPDATE `timesheets` SET status = 'paid', updated_at = ? WHERE status = 'consolidated' AND work_date BETWEEN ? AND ? AND employee_id IN ($in)",
            array_merge([Db::nowSql(), $run['period_start'], $run['period_end']], $emp));
    }
    journal($run['period_end'], $run['name'], 'Payroll', [['6100', $run['total_gross'], 0], ['2100', 0, $run['total_net']], ['2200', 0, r2($run['total_gross'] - $run['total_net'])]]);
    return Db::update('payroll_runs', $id, ['status' => 'approved']);
}

function routes_hr(callable $route): void
{
    $route('GET', 'hr/training/compliance', act([], fn() => hr_compliance()));
    $route('POST', 'hr/training/generate', act(['hr', 'planning'], fn($p, $b) => hr_generate_training($b['run_id'] ?? null)));
    $route('POST', 'hr/timekeeping/consolidate', act(['hr'], fn() => hr_consolidate()));
    $route('GET', 'hr/timekeeping/summary', act([], fn() => hr_time_summary($_GET['from'] ?? null, $_GET['to'] ?? null)));
    $route('POST', 'hr/payroll/run', act(['hr'], fn($p, $b) => hr_run_payroll($b)));
    $route('POST', 'hr/payroll/{id}/approve', act(['hr', 'finance'], fn($p) => hr_approve_payroll($p['id'])));
}
