// HR: training matrix compliance + MRP-driven scheduling, timekeeping consolidation, payroll.
import { db } from '../store/index.js';
import { addDays, byId, daysBetween, fail, groupBy, num, overlap, r2, sum, today } from '../util.js';
import { journal, setting } from './common.js';

const latest = (records, emp, course) => records.filter(r => r.employee_id === emp && r.course_id === course).sort((a, b) => String(b.completed_date).localeCompare(String(a.completed_date)))[0];
const requiredFor = (matrix, position) => [...new Set(matrix.filter(m => m.position === 'All Personnel' || m.position === position).map(m => m.course_id))];

// Courses each assigned crew member is missing (or that expire before the project ends).
export async function trainingNeeds(plan) {
  const [matrix, records, courses, emps] = await Promise.all(['training_matrix', 'training_records', 'training_courses', 'employees'].map(t => db.list(t)));
  const C = byId(courses), E = byId(emps), needs = [];
  for (const c of plan.crew.filter(c => c.employee_id)) {
    for (const cid of requiredFor(matrix, E[c.employee_id]?.position)) {
      const rec = latest(records, c.employee_id, cid);
      if (rec && (!rec.expiry_date || rec.expiry_date >= plan.end_date)) continue;
      if (C[cid]) needs.push({ employee_id: c.employee_id, name: c.name, course_id: cid, course: C[cid].name, pillar: C[cid].pillar, duration_days: num(C[cid].duration_days) || 1,
        reason: rec ? `Certificate expires ${rec.expiry_date}` : 'No valid certificate' });
    }
  }
  return needs;
}

// 4.2.1 Generate training schedules from an approved and firmed MRP run.
export async function generateTraining(runId) {
  const run = await db.get('mrp_runs', runId) || fail(404, 'MRP run not found');
  if (run.status !== 'firmed') fail(400, 'Training schedules are generated from an approved and firmed MRP run');
  const [schedules, leaves] = await Promise.all([db.list('training_schedules'), db.list('leaves')]);
  const rows = [];
  for (const plan of run.result.plans) {
    for (const n of await trainingNeeds(plan)) {
      const dup = s => s.employee_id === n.employee_id && s.course_id === n.course_id && ['planned', 'confirmed'].includes(s.status);
      if (schedules.some(dup) || rows.some(dup)) continue;
      // Latest slot that finishes 2 days before mobilisation, moved earlier around approved leave.
      let end = addDays(plan.start_date, -2), start = addDays(end, -(n.duration_days - 1)), note = n.reason;
      const onLeave = () => leaves.some(l => l.employee_id === n.employee_id && l.status === 'approved' && overlap(l.start_date, l.end_date, start, end));
      for (let i = 0; i < 45 && onLeave() && start > addDays(today(), 1); i++) { start = addDays(start, -1); end = addDays(end, -1); }
      if (start <= today()) {
        start = addDays(today(), 1); end = addDays(start, n.duration_days - 1);
        if (end >= plan.start_date) note += ' - cannot finish before mobilisation, expedite or reassign';
      }
      rows.push({ employee_id: n.employee_id, course_id: n.course_id, start_date: start, end_date: end, status: 'planned', source: `MRP ${run.run_no}`, mrp_run_id: runId, project_id: plan.project_id, note });
    }
  }
  await db.insert('training_schedules', rows);
  return { created: rows.length };
}

// Employee x course compliance grid for the training matrix page.
export async function compliance() {
  const [emps, courses, matrix, records, schedules] = await Promise.all(['employees', 'training_courses', 'training_matrix', 'training_records', 'training_schedules'].map(t => db.list(t)));
  const soon = addDays(today(), 60);
  const rows = emps.filter(e => e.status !== 'inactive').map(e => {
    const req = requiredFor(matrix, e.position), cells = {};
    for (const cid of req) {
      const rec = latest(records, e.id, cid);
      const sch = schedules.find(s => s.employee_id === e.id && s.course_id === cid && ['planned', 'confirmed'].includes(s.status));
      let state = !rec ? 'missing' : rec.expiry_date && rec.expiry_date < today() ? 'expired' : rec.expiry_date && rec.expiry_date <= soon ? 'expiring' : 'valid';
      if (sch && state !== 'valid') state = 'scheduled';
      cells[cid] = { state, expiry: rec?.expiry_date, scheduled: sch?.start_date };
    }
    const ok = req.filter(c => ['valid', 'expiring'].includes(cells[c].state)).length;
    return { id: e.id, name: e.name, position: e.position, cells, pct: req.length ? Math.round(ok / req.length * 100) : 100 };
  });
  return { courses: courses.sort((a, b) => String(a.pillar).localeCompare(b.pillar) || String(a.code).localeCompare(b.code)), rows };
}

// ---- 4.6 Timekeeping ----
export async function recalcAccumulated(empIds) {
  const ts = (await db.list('timesheets')).filter(t => t.status !== 'captured');
  const by = groupBy(ts, 'employee_id');
  for (const id of empIds) {
    const rows = by[id] || [];
    await db.update('employees', id, { accumulated_hours: r2(sum(rows, r => num(r.regular_hours) + num(r.ot_hours))), accumulated_days: new Set(rows.map(r => r.work_date)).size });
  }
}
export async function consolidate() {
  const pending = await db.list('timesheets', { status: 'captured' });
  for (const t of pending) await db.update('timesheets', t.id, { status: 'consolidated' });
  await recalcAccumulated([...new Set(pending.map(t => t.employee_id))]);
  return { consolidated: pending.length };
}
export function streak(dates, asOf) {
  const set = new Set(dates);
  let n = 0;
  for (let d = asOf; set.has(d); d = addDays(d, -1)) n++;
  return n;
}
export async function timeSummary(from, to) {
  const [emps, ts] = await Promise.all([db.list('employees'), db.list('timesheets')]);
  const limit = num(await setting('max_work_days', 15));
  const by = groupBy(ts, 'employee_id');
  return { limit, rows: emps.filter(e => by[e.id]).map(e => {
    const all = by[e.id], rows = all.filter(t => (!from || t.work_date >= from) && (!to || t.work_date <= to));
    const dates = all.map(t => t.work_date).sort(), last = dates[dates.length - 1];
    return { id: e.id, name: e.name, position: e.position, regular_hours: r2(sum(rows, 'regular_hours')), ot_hours: r2(sum(rows, 'ot_hours')), days: new Set(rows.map(t => t.work_date)).size,
      unconsolidated: rows.filter(t => t.status === 'captured').length, last_worked: last, consecutive_days: streak(dates, last) };
  }).filter(r => r.days).sort((a, b) => b.consecutive_days - a.consecutive_days) };
}

// ---- 4.7 Payroll ----
export async function runPayroll({ period_start, period_end }) {
  if (!period_start || !period_end || period_end < period_start) fail(400, 'Enter a valid pay period');
  const [emps, ts, leaves] = await Promise.all([db.list('employees'), db.list('timesheets', { status: 'consolidated' }), db.list('leaves', { status: 'approved' })]);
  const [otMult, taxPct, contribPct, dayHours] = await Promise.all([setting('ot_multiplier', 1.25), setting('payroll_tax_pct', 10), setting('payroll_contribution_pct', 4.5), setting('regular_hours_per_day', 8)]);
  const inPeriod = groupBy(ts.filter(t => t.work_date >= period_start && t.work_date <= period_end), 'employee_id');
  const slips = [];
  for (const e of emps) {
    const rows = inPeriod[e.id] || [];
    const leave_days = sum(leaves.filter(l => l.employee_id === e.id && l.paid && overlap(l.start_date, l.end_date, period_start, period_end)),
      l => daysBetween(l.start_date > period_start ? l.start_date : period_start, l.end_date < period_end ? l.end_date : period_end) + 1);
    if (!rows.length && !leave_days) continue;
    const rate = num(e.hourly_rate), regular_hours = sum(rows, 'regular_hours'), ot_hours = sum(rows, 'ot_hours'), days_worked = new Set(rows.map(r => r.work_date)).size;
    const basic_pay = r2(regular_hours * rate), ot_pay = r2(ot_hours * rate * num(otMult)), leave_pay = r2(leave_days * num(dayHours) * rate), allowances = r2(days_worked * num(e.daily_allowance));
    const gross_pay = r2(basic_pay + ot_pay + leave_pay + allowances), deductions = r2(gross_pay * (num(taxPct) + num(contribPct)) / 100);
    slips.push({ employee_id: e.id, days_worked, regular_hours, ot_hours, leave_days, basic_pay, ot_pay, leave_pay, allowances, gross_pay, deductions, net_pay: r2(gross_pay - deductions) });
  }
  if (!slips.length) fail(400, 'No consolidated timesheets or paid leaves in this period. Consolidate timesheets first.');
  const run = await db.insert('payroll_runs', { name: `Payroll ${period_start} to ${period_end}`, period_start, period_end, status: 'draft', total_gross: r2(sum(slips, 'gross_pay')), total_net: r2(sum(slips, 'net_pay')) });
  await db.insert('payslips', slips.map(s => ({ ...s, run_id: run.id })));
  return run;
}
export async function approvePayroll(id) {
  const run = await db.get('payroll_runs', id) || fail(404, 'Payroll run not found');
  if (run.status !== 'draft') fail(400, 'Payroll run already approved');
  const slips = await db.list('payslips', { run_id: id });
  const paidEmp = new Set(slips.map(s => s.employee_id));
  for (const t of await db.list('timesheets', { status: 'consolidated' }))
    if (paidEmp.has(t.employee_id) && t.work_date >= run.period_start && t.work_date <= run.period_end) await db.update('timesheets', t.id, { status: 'paid' });
  await journal(run.period_end, run.name, 'Payroll', [['6100', run.total_gross, 0], ['2100', 0, run.total_net], ['2200', 0, r2(run.total_gross - run.total_net)]]);
  return db.update('payroll_runs', id, { status: 'approved' });
}
