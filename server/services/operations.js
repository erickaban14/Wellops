// Project operations: Daily Work Tickets (online + offline sync), posting to timesheets/stock/costs,
// work-day limit alerts, planned-vs-actual project overview.
import { db } from '../store/index.js';
import { addDays, byId, fail, groupBy, now, num, r2, sum, today } from '../util.js';
import { journal, notify, setting } from './common.js';
import { recalcAccumulated, streak } from './hr.js';

const FIELDS = ['client_id', 'project_id', 'work_date', 'shift', 'supervisor_id', 'status', 'entry_mode', 'incidents', 'remarks', 'lines', 'crew', 'materials'];

// Upsert a ticket. client_id makes offline re-sends idempotent.
export async function saveTicket(body, user) {
  if (!body.project_id || !body.work_date) fail(400, 'Project and work date are required');
  const existing = body.id ? await db.get('work_tickets', body.id) : body.client_id ? (await db.list('work_tickets', { client_id: body.client_id }))[0] : null;
  if (existing?.status === 'approved') fail(400, 'Approved tickets cannot be changed');
  const row = Object.fromEntries(FIELDS.filter(f => f in body).map(f => [f, body[f]]));
  row.status ||= 'draft'; row.entry_mode ||= 'online';
  if (row.entry_mode === 'offline') row.synced_at = now();
  const ticket = existing ? await db.update('work_tickets', existing.id, row)
    : await db.insert('work_tickets', { ...row, ticket_no: await db.nextNo('work_tickets', 'ticket_no', 'DWT-'), supervisor_id: row.supervisor_id || user.employee_id });
  if (ticket.status !== 'draft') await postTicket(ticket);
  return ticket;
}

export async function approveTicket(id, user) {
  if (!['rig_supervisor', 'rig_manager', 'operations_head', 'admin'].includes(user.role)) fail(403, 'Only a supervisor or manager can approve work tickets');
  const t = await db.get('work_tickets', id) || fail(404, 'Ticket not found');
  if (t.status !== 'submitted') fail(400, 'Only submitted tickets can be approved');
  return db.update('work_tickets', id, { status: 'approved', remarks: [t.remarks, `Approved by ${user.name}`].filter(Boolean).join('\n') });
}

// Posting is idempotent: previous effects of this ticket are reversed, then re-applied.
async function postTicket(t) {
  const [project, emps, items] = await Promise.all([db.get('projects', t.project_id), db.list('employees'), db.list('items')]);
  if (!project) fail(400, 'Project not found');
  const E = byId(emps), I = byId(items), ref = t.ticket_no;
  const before = Object.fromEntries(items.map(i => [i.id, i.on_hand]));
  for (const x of await db.list('timesheets', { ticket_id: t.id })) await db.remove('timesheets', x.id);
  for (const x of await db.list('project_costs', { ref })) await db.remove('project_costs', x.id);
  for (const x of await db.list('stock_moves', { ref })) { if (I[x.item_id]) I[x.item_id].on_hand = num(I[x.item_id].on_hand) + num(x.qty); await db.remove('stock_moves', x.id); }

  // Timesheets + labour cost
  const [dayHours, otMult, auto] = await Promise.all([setting('regular_hours_per_day', 8), setting('ot_multiplier', 1.25), setting('auto_consolidate_online', 'true')]);
  const status = t.entry_mode === 'online' && String(auto) === 'true' ? 'consolidated' : 'captured';
  const crew = (t.crew || []).filter(c => c.employee_id && num(c.hours) > 0);
  let labor = 0;
  await db.insert('timesheets', crew.map(c => {
    const reg = Math.min(num(c.hours), num(dayHours)), ot = num(c.hours) - reg;
    labor += (reg + ot * num(otMult)) * num(E[c.employee_id]?.hourly_rate);
    return { employee_id: c.employee_id, project_id: t.project_id, work_date: t.work_date, regular_hours: reg, ot_hours: ot, source: 'dwt', ticket_id: t.id, status };
  }));
  const costs = [];
  if (labor) costs.push({ category: 'labor', amount: r2(labor), description: `Crew labour ${ref}` });

  // Material issues
  let matCost = 0;
  for (const m of (t.materials || []).filter(m => m.item_id && num(m.qty) > 0)) {
    const it = I[m.item_id]; if (!it) continue;
    it.on_hand = num(it.on_hand) - num(m.qty);
    await db.insert('stock_moves', { move_date: now(), move_type: 'issue', item_id: it.id, qty: num(m.qty), unit_cost: num(it.unit_cost), project_id: t.project_id, ref, qa_status: 'n/a', remarks: 'Consumed on work ticket' });
    matCost += num(m.qty) * num(it.unit_cost);
  }
  for (const it of items) if (it.on_hand !== before[it.id]) await db.update('items', it.id, { on_hand: it.on_hand });
  if (matCost) { costs.push({ category: 'material', amount: r2(matCost), description: `Materials consumed ${ref}` }); await journal(t.work_date, ref, 'Materials consumed', [['5000', matCost, 0], ['1300', 0, matCost]], t.project_id); }

  // Machine day rate: once per project per day
  if (project.machine_id) {
    const dayRef = `DAYRATE ${t.work_date}`;
    const have = (await db.list('project_costs', { project_id: t.project_id, ref: dayRef })).length;
    const rate = num((await db.get('machines', project.machine_id))?.day_rate);
    if (!have && rate) await db.insert('project_costs', { project_id: t.project_id, cost_date: t.work_date, category: 'equipment', amount: rate, description: 'Machine day rate', ref: dayRef });
  }
  await db.insert('project_costs', costs.map(c => ({ ...c, project_id: t.project_id, cost_date: t.work_date, ref })));
  if (project.status === 'planned') {
    await db.update('projects', project.id, { status: 'active' });
    if (project.machine_id) await db.update('machines', project.machine_id, { status: 'deployed' });
    if (project.so_id) await db.update('sales_orders', project.so_id, { status: 'in progress' });
  }
  await recalcProject(t.project_id);
  if (status === 'consolidated') await recalcAccumulated(crew.map(c => c.employee_id));
  await checkWorkLimit(t, crew.map(c => c.employee_id), E);
}

// Activity actuals and issued quantities are always recomputed from source documents.
async function recalcProject(project_id) {
  const [tickets, acts, mats, moves] = await Promise.all([db.list('work_tickets', { project_id }), db.list('project_activities', { project_id }), db.list('project_materials', { project_id }), db.list('stock_moves', { project_id })]);
  const lines = tickets.filter(t => t.status !== 'draft').sort((a, b) => a.work_date.localeCompare(b.work_date)).flatMap(t => t.lines || []);
  for (const a of acts) {
    const mine = lines.filter(l => l.activity_id === a.id);
    if (!mine.length && !num(a.actual_hours)) continue;
    const hours = r2(sum(mine, 'hours')), pcts = mine.map(l => num(l.pct_complete)).filter(Boolean);
    const pct = Math.min(100, pcts.length ? Math.max(...pcts) : hours ? Math.min(95, Math.round(hours / num(a.planned_hours) * 100)) : 0);
    await db.update('project_activities', a.id, { actual_hours: hours, pct_complete: pct, status: pct >= 100 ? 'done' : hours ? 'in progress' : 'pending' });
  }
  for (const m of mats) {
    const issued = sum(moves.filter(x => x.item_id === m.item_id), x => (x.move_type === 'issue' ? num(x.qty) : x.move_type === 'return in' ? -num(x.qty) : 0));
    if (issued !== num(m.qty_issued)) await db.update('project_materials', m.id, { qty_issued: issued });
  }
}

// 4.4.4 Alert the Rig Manager when someone works beyond the maximum consecutive days (Timekeeping setting, default 15).
async function checkWorkLimit(t, empIds, E) {
  const limit = num(await setting('max_work_days', 15));
  const [ts, alerts] = await Promise.all([db.list('timesheets'), db.list('work_limit_alerts')]);
  const by = groupBy(ts, 'employee_id');
  for (const id of new Set(empIds)) {
    const days = streak((by[id] || []).map(x => x.work_date), t.work_date);
    if (days <= limit) continue;
    const mine = alerts.filter(a => a.employee_id === id);
    if (mine.some(a => a.status === 'pending' || (a.status === 'approved' && a.as_of >= t.work_date))) continue;
    const alert = await db.insert('work_limit_alerts', { employee_id: id, project_id: t.project_id, as_of: t.work_date, consecutive_days: days, limit_days: limit, status: 'pending' });
    await notify('rig_manager', 'Work-day limit exceeded', `${E[id]?.name} has worked ${days} consecutive days (limit ${limit}). Approval required to continue.`, { kind: 'approval', ref_table: 'work_limit_alerts', ref_id: alert.id });
  }
}
export async function decideAlert(id, approve, user, note) {
  const a = await db.get('work_limit_alerts', id) || fail(404, 'Alert not found');
  if (a.status !== 'pending') fail(400, 'Alert already decided');
  if (!['rig_manager', 'operations_head', 'admin'].includes(user.role)) fail(403, 'Only the Rig Manager can decide work-limit approvals');
  if (!approve && !String(note || '').trim()) fail(400, 'A reason is required when rejecting');
  return db.update('work_limit_alerts', id, { status: approve ? 'approved' : 'rejected', decided_by: user.name, decided_at: now(), decision_note: note || '' });
}

// 4.4.3 / 4.4.5 Planned vs actual, exceptions, KPIs and accumulated cost for one project.
export async function overview(project_id, pre) {
  const get = async (t, where) => (pre ? (await pre(t)).filter(r => Object.entries(where).every(([k, v]) => r[k] === v)) : db.list(t, where));
  const project = pre ? (await pre('projects')).find(p => p.id === project_id) : await db.get('projects', project_id);
  if (!project) fail(404, 'Project not found');
  const [activities, materials, manning, kpis, costs, tickets, alerts] = await Promise.all(
    ['project_activities', 'project_materials', 'project_manning', 'project_kpis', 'project_costs', 'work_tickets', 'work_limit_alerts'].map(t => get(t, { project_id })));
  activities.sort((a, b) => a.seq - b.seq);
  const t0 = Date.now(), totalH = sum(activities, 'planned_hours') || 1;
  const frac = a => Math.max(0, Math.min(1, (t0 - new Date(a.planned_start)) / (new Date(a.planned_end) - new Date(a.planned_start) || 1)));
  const planned_pct = Math.round(sum(activities, a => num(a.planned_hours) * frac(a)) / totalH * 100);
  const actual_pct = Math.round(sum(activities, a => num(a.planned_hours) * num(a.pct_complete) / 100) / totalH * 100);
  const posted = tickets.filter(t => t.status !== 'draft'), lines = posted.flatMap(t => t.lines || []);
  const hours = sum(lines, 'hours'), npt = sum(lines.filter(l => l.npt), 'hours');
  const cost = r2(sum(costs, 'amount')), budget = num(project.budget), earned = budget * actual_pct / 100;
  const footage = sum(lines, l => Math.max(0, num(l.depth_to) - num(l.depth_from))), drillH = sum(lines.filter(l => num(l.depth_to) > num(l.depth_from)), 'hours');
  const auto = { npt_pct: hours ? r2(npt / hours * 100) : 0, cost_var_pct: earned ? r2((cost - earned) / earned * 100) : 0, schedule_var_pct: actual_pct - planned_pct,
    incidents: sum(posted, 'incidents'), rop: drillH ? r2(footage / drillH) : null };
  const kpiRows = kpis.map(k => {
    const actual = k.auto_key && auto[k.auto_key] != null ? auto[k.auto_key] : k.actual;
    const ok = actual == null || actual === '' ? null : k.direction === 'at least' ? num(actual) >= num(k.target) : num(actual) <= num(k.target);
    return { ...k, actual, ok };
  });

  const ex = [];
  if (project.status !== 'completed') {
    for (const a of activities) {
      if (new Date(a.planned_end) < t0 && num(a.pct_complete) < 100) ex.push({ level: 'high', type: 'Schedule', text: `"${a.name}" should be complete (${num(a.pct_complete)}% done)` });
      else if (new Date(a.planned_start) < t0 && !num(a.actual_hours) && num(a.pct_complete) < 100) ex.push({ level: 'medium', type: 'Schedule', text: `"${a.name}" has not started` });
      if (num(a.actual_hours) > num(a.planned_hours) * 1.1) ex.push({ level: 'medium', type: 'Hours', text: `"${a.name}" used ${a.actual_hours}h vs ${a.planned_hours}h planned` });
    }
    if (budget && cost > budget) ex.push({ level: 'high', type: 'Cost', text: `Cost ${cost.toLocaleString()} exceeds budget ${budget.toLocaleString()}` });
    else if (earned && cost > earned * 1.1) ex.push({ level: 'medium', type: 'Cost', text: `Cost is ${Math.round((cost / earned - 1) * 100)}% above earned value` });
    if (npt) ex.push({ level: npt / hours > 0.05 ? 'high' : 'low', type: 'NPT', text: `${npt}h non-productive time (${auto.npt_pct}%)` });
    if (auto.incidents) ex.push({ level: 'high', type: 'HSE', text: `${auto.incidents} incident(s) reported` });
    const gaps = manning.filter(m => m.status === 'shortage').length;
    if (gaps) ex.push({ level: 'medium', type: 'Manning', text: `${gaps} crew position(s) unfilled` });
    for (const m of materials) if (num(m.qty_issued) > num(m.qty_required)) ex.push({ level: 'low', type: 'Material', text: `Material over-issued: ${m.qty_issued} vs ${m.qty_required} planned`, item_id: m.item_id });
    const pend = alerts.filter(a => a.status === 'pending').length;
    if (pend) ex.push({ level: 'high', type: 'Work limit', text: `${pend} work-day limit approval(s) pending` });
    if (project.status === 'planned' && project.start_date < today()) ex.push({ level: 'medium', type: 'Schedule', text: 'Planned start date has passed with no work ticket' });
  }
  // Day-by-day trend: planned vs actual progress (%) and cumulative cost vs planned spend.
  const trend = [];
  if (activities.length) {
    const last = [today(), project.end_date].sort()[0], sorted = [...posted].sort((a, b) => a.work_date.localeCompare(b.work_date));
    for (let d = project.start_date; d <= last && trend.length < 120; d = addDays(d, 1)) {
      const at = new Date(d + 'T23:59:59Z').getTime();
      const fr = a => Math.max(0, Math.min(1, (at - new Date(a.planned_start)) / (new Date(a.planned_end) - new Date(a.planned_start) || 1)));
      const plannedD = Math.round(sum(activities, a => num(a.planned_hours) * fr(a)) / totalH * 100);
      const dayLines = sorted.filter(t => t.work_date <= d).flatMap(t => t.lines || []);
      const actualD = Math.round(sum(activities, a => {
        const mine = dayLines.filter(l => l.activity_id === a.id); if (!mine.length) return 0;
        const pcts = mine.map(l => num(l.pct_complete)).filter(Boolean);
        return num(a.planned_hours) * Math.min(100, pcts.length ? Math.max(...pcts) : Math.min(95, sum(mine, 'hours') / num(a.planned_hours) * 100)) / 100;
      }) / totalH * 100);
      trend.push({ date: d, planned: plannedD, actual: actualD, cost: r2(sum(costs.filter(c => c.cost_date <= d), 'amount')), planned_cost: Math.round(budget * plannedD / 100) });
    }
  }
  const byCat = groupBy(costs, 'category');
  return { project, activities, materials, manning, kpis: kpiRows, tickets: posted.length, planned_pct, actual_pct, deviation: actual_pct - planned_pct, cost, budget,
    cost_by_category: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, r2(sum(v, 'amount'))])), hours, npt, exceptions: ex, trend };
}
