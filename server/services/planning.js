// Planning: API-based machine selection, MPS, MRP run (activities, materials, manning, machines, KPIs), availability checks.
import { db } from '../store/index.js';
import { addDays, byId, fail, now, num, overlap, r2, today } from '../util.js';
import { generateTraining, trainingNeeds } from './hr.js';
import { generateRfqs } from './procurement.js';

const codes = s => String(s || '').toUpperCase().split(/[,;/]+/).map(c => c.replace(/API|SPEC|STD|RP|\s/g, '')).filter(Boolean);
const open = s => !['done', 'completed', 'cancelled', 'rejected'].includes(s);

// ---- 4.3 Machine selection: rank machines against API code, well depth, target flow rate and operation ----
export async function selectMachine({ api_code, depth_ft, flow_gpm, operation, start, end, busy = [] }) {
  const [machines, pms, projects, docs, stds] = await Promise.all(['machines', 'maintenance_plans', 'projects', 'documents', 'api_standards'].map(t => db.list(t)));
  const depth = num(depth_ft), flow = num(flow_gpm), want = codes(api_code);
  const standards = stds.filter(s => want.some(w => codes(s.code).includes(w)) || (operation && [operation, 'all'].includes(s.operation)));
  const ranked = machines.filter(m => m.status !== 'retired').map(m => {
    const pass = [], failed = [], mc = codes(m.api_code), util = [];
    const test = (ok, text) => (ok ? pass : failed).push(text);
    if (operation) test(m.operation === operation, `Operation: ${m.operation}`);
    if (want.length) test(want.every(w => mc.includes(w)), `API ${m.api_code || 'n/a'} vs required ${api_code}`);
    if (depth && num(m.max_depth_ft)) { test(m.max_depth_ft >= depth, `Depth rating ${m.max_depth_ft} ft vs ${depth} ft`); util.push(depth / m.max_depth_ft); }
    if (flow && num(m.max_flow_gpm)) { test(m.max_flow_gpm >= flow, `Flow rating ${m.max_flow_gpm} gpm vs ${flow} gpm`); util.push(flow / m.max_flow_gpm); }
    const conflicts = [];
    if (start && end) {
      for (const p of pms) if (p.machine_id === m.id && open(p.status) && overlap(p.start_date, p.end_date, start, end))
        conflicts.push(`${p.pm_type || 'PM'} ${p.start_date} to ${p.end_date}${p.description ? ` (${p.description})` : ''}`);
      for (const p of projects) if (p.machine_id === m.id && open(p.status) && overlap(p.start_date, p.end_date, start, end))
        conflicts.push(`Deployed on ${p.code} ${p.start_date} to ${p.end_date}`);
      for (const b of busy) if (b.machine_id === m.id && overlap(b.start, b.end, start, end)) conflicts.push(`Allocated in this run ${b.start} to ${b.end}`);
    }
    // Best fit = capable machine loaded closest to 85% of its rating (not undersized, not wastefully oversized).
    const load = util.length ? util.reduce((a, b) => a + b) / util.length : 0.85;
    const score = failed.length ? 0 : Math.max(1, Math.round(100 - Math.abs(0.85 - load) * 70 - (conflicts.length ? 35 : 0)));
    return { machine: m, eligible: !failed.length, available: !conflicts.length, score, load_pct: Math.round(load * 100), pass, failed, conflicts,
      manuals: docs.filter(d => d.machine_id === m.id || (!d.machine_id && codes(d.api_code).some(c => mc.includes(c)))).map(d => ({ id: d.id, title: d.title, doc_type: d.doc_type, has_file: !!d.storage_path })) };
  }).sort((a, b) => b.eligible - a.eligible || b.score - a.score);
  return { ranked, standards, best: ranked.find(r => r.eligible && r.available) || null };
}

// ---- MPS: pull confirmed sales orders into the master schedule ----
export async function generateMps() {
  const [orders, lines] = await Promise.all([db.list('sales_orders', { status: 'confirmed' }), db.list('mps_lines')]);
  const fresh = orders.filter(o => !lines.some(l => l.so_id === o.id));
  const rows = [];
  for (const o of fresh) {
    const start = o.requested_start || addDays(today(), 14);
    const { best } = await selectMachine({ api_code: o.api_code, depth_ft: o.target_depth_ft, flow_gpm: o.target_flow_gpm, operation: o.operation, start, end: addDays(start, 30) });
    rows.push({ so_id: o.id, well_id: o.well_id, operation: o.operation, api_code: o.api_code, depth_ft: o.target_depth_ft, flow_gpm: o.target_flow_gpm, start_date: start, machine_id: best?.machine.id, status: 'draft' });
  }
  await db.insert('mps_lines', rows);
  return { created: rows.length };
}

// ---- 4.3.2 / 4.3.3 availability board ----
export async function availability(start, end) {
  const [emps, leaves, trainings, manning, machines, pms, projects, courses] = await Promise.all(
    ['employees', 'leaves', 'training_schedules', 'project_manning', 'machines', 'maintenance_plans', 'projects', 'training_courses'].map(t => db.list(t)));
  const P = byId(projects), C = byId(courses);
  const people = emps.filter(e => e.status !== 'inactive').map(e => ({ id: e.id, name: e.name, position: e.position, blocks: empBlocks(e.id, start, end, { leaves, trainings, manning, P, C }) }));
  const fleet = machines.filter(m => m.status !== 'retired').map(m => ({ id: m.id, name: `${m.code} ${m.name}`, operation: m.operation, blocks: [
    ...pms.filter(p => p.machine_id === m.id && open(p.status) && overlap(p.start_date, p.end_date, start, end)).map(p => ({ kind: 'maintenance', from: p.start_date, to: p.end_date, text: p.description || p.pm_type })),
    ...projects.filter(p => p.machine_id === m.id && open(p.status) && overlap(p.start_date, p.end_date, start, end)).map(p => ({ kind: 'project', from: p.start_date, to: p.end_date, text: p.code }))] }));
  return { start, end, people, fleet };
}
function empBlocks(id, start, end, { leaves, trainings, manning, P, C }) {
  return [
    ...leaves.filter(l => l.employee_id === id && l.status === 'approved' && overlap(l.start_date, l.end_date, start, end)).map(l => ({ kind: 'leave', from: l.start_date, to: l.end_date, text: `${l.leave_type} leave` })),
    ...trainings.filter(t => t.employee_id === id && ['planned', 'confirmed'].includes(t.status) && overlap(t.start_date, t.end_date, start, end)).map(t => ({ kind: 'training', from: t.start_date, to: t.end_date, text: C[t.course_id]?.name || 'Training' })),
    ...manning.filter(m => m.employee_id === id && open(P[m.project_id]?.status) && overlap(m.start_date, m.end_date, start, end)).map(m => ({ kind: 'project', from: m.start_date, to: m.end_date, text: P[m.project_id]?.code || 'Project' })),
  ];
}

// ---- 4.3.1 MRP run over all firmed MPS lines ----
export async function runMrp(user) {
  const lines = (await db.list('mps_lines', { status: 'firmed' })).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (!lines.length) fail(400, 'No firmed Master Schedule lines to plan. Firm at least one MPS line first.');
  const T = {};
  for (const t of ['items', 'activity_templates', 'material_templates', 'crew_templates', 'kpi_templates', 'employees', 'leaves', 'training_schedules', 'project_manning', 'projects', 'wells', 'sales_orders', 'customers', 'training_courses'])
    T[t] = await db.list(t);
  const I = byId(T.items), W = byId(T.wells), P = byId(T.projects), C = byId(T.training_courses), SO = byId(T.sales_orders);
  const allocated = {}, busyEmp = [], busyMach = [], plans = [];

  for (const line of lines) {
    const depth = num(line.depth_ft), k = depth / 1000, exceptions = [];
    // Activities with timeline in days and hours (24-hour operations, starting 06:00)
    let cursor = new Date(`${line.start_date}T06:00:00Z`).getTime();
    const activities = T.activity_templates.filter(a => a.operation === line.operation).sort((a, b) => a.seq - b.seq).map(a => {
      const hours = Math.max(1, Math.round(num(a.base_hours) + num(a.hours_per_1000ft) * k));
      const row = { seq: a.seq, name: a.name, planned_hours: hours, planned_start: new Date(cursor).toISOString(), planned_end: new Date(cursor + hours * 36e5).toISOString() };
      cursor += hours * 36e5;
      return row;
    });
    if (!activities.length) exceptions.push(`No activity template for operation "${line.operation}"`);
    const total_hours = activities.reduce((a, r) => a + r.planned_hours, 0);
    const end_date = new Date(cursor).toISOString().slice(0, 10);
    const days = Math.max(1, Math.ceil(total_hours / 24));

    // Machine: preferred if capable and free, else best alternative (checks PM plans and other deployments)
    const sel = await selectMachine({ api_code: line.api_code, depth_ft: depth, flow_gpm: line.flow_gpm, operation: line.operation, start: line.start_date, end: end_date, busy: busyMach });
    const pref = sel.ranked.find(r => r.machine.id === line.machine_id);
    let pick = pref?.eligible && pref.available ? pref : sel.best;
    if (pref && pick && pick !== pref) exceptions.push(`Preferred machine ${pref.machine.code} not usable (${[...pref.failed, ...pref.conflicts].join('; ')}). Switched to ${pick.machine.code}.`);
    if (!pick) exceptions.push(`No capable machine available ${line.start_date} to ${end_date}. Rental/purchase requisition will be raised.`);
    if (pick) busyMach.push({ machine_id: pick.machine.id, start: line.start_date, end: end_date });
    const machine = pick ? { id: pick.machine.id, code: pick.machine.code, name: pick.machine.name, accessories: pick.machine.accessories, day_rate: num(pick.machine.day_rate), score: pick.score } : null;

    // Materials, supplies and tools: gross requirement -> stock allocation -> net shortage -> order-by date from lead time
    const materials = T.material_templates.filter(m => m.operation === line.operation && I[m.item_id]).map(m => {
      const it = I[m.item_id], required = Math.ceil(num(m.base_qty) + num(m.qty_per_1000ft) * k);
      const free = Math.max(0, num(it.on_hand) - num(it.safety_stock) - (allocated[it.id] || 0));
      const from_stock = Math.min(required, free), short = required - from_stock;
      allocated[it.id] = (allocated[it.id] || 0) + from_stock;
      const order_qty = short ? Math.max(short, num(it.min_order_qty)) : 0;
      const order_by = short ? addDays(line.start_date, -num(it.lead_time_days)) : null;
      if (short && order_by < today()) exceptions.push(`${it.name}: lead time ${num(it.lead_time_days)}d means ordering was due ${order_by} - expedite.`);
      return { item_id: it.id, code: it.code, name: it.name, category: it.category, uom: it.uom, required, from_stock, short, order_qty, order_by, need_date: line.start_date, unit_cost: num(it.unit_cost) };
    });

    // Field manning: by position, validated against leaves, trainings and other project assignments
    const crew = [];
    for (const ct of T.crew_templates.filter(c => c.operation === line.operation)) {
      for (let i = 0; i < num(ct.qty); i++) {
        const blocked = [];
        const emp = T.employees.find(e => {
          if (e.position !== ct.position || e.status === 'inactive') return false;
          const why = [...empBlocks(e.id, line.start_date, end_date, { leaves: T.leaves, trainings: T.training_schedules, manning: T.project_manning, P, C }).map(b => `${b.text} ${b.from} to ${b.to}`),
            ...busyEmp.filter(b => b.employee_id === e.id && overlap(b.start, b.end, line.start_date, end_date)).map(() => 'allocated in this run')];
          if (why.length) { blocked.push(`${e.name}: ${why[0]}`); return false; }
          return true;
        });
        if (emp) busyEmp.push({ employee_id: emp.id, start: line.start_date, end: end_date });
        crew.push({ position: ct.position, employee_id: emp?.id || null, name: emp?.name || null, hourly_rate: num(emp?.hourly_rate), status: emp ? 'assigned' : 'shortage', blocked });
      }
    }
    const gaps = crew.filter(c => !c.employee_id);
    if (gaps.length) exceptions.push(`Manpower shortage: ${Object.entries(gaps.reduce((a, c) => (a[c.position] = (a[c.position] || 0) + 1, a), {})).map(([p, n]) => `${n} x ${p}`).join(', ')}`);

    const so = SO[line.so_id], well = W[line.well_id];
    const cost = {
      labor: r2(crew.reduce((a, c) => a + c.hourly_rate * 12 * days, 0)),
      material: r2(materials.reduce((a, m) => a + m.required * m.unit_cost, 0)),
      equipment: r2((machine?.day_rate || 0) * days),
    };
    const plan = { mps_id: line.id, so_id: line.so_id, customer_id: so?.customer_id || well?.customer_id || null, well_id: line.well_id,
      name: `${line.operation[0].toUpperCase() + line.operation.slice(1)} - ${well?.name || so?.so_no || 'Well'}`, operation: line.operation, api_code: line.api_code, depth_ft: depth, flow_gpm: num(line.flow_gpm),
      start_date: line.start_date, end_date, total_hours, duration: `${Math.floor(total_hours / 24)}d ${total_hours % 24}h`, machine, machine_alternatives: sel.ranked.filter(r => r.eligible).slice(0, 4).map(r => ({ code: r.machine.code, name: r.machine.name, score: r.score, available: r.available, conflicts: r.conflicts })),
      activities, materials, crew, cost, budget: r2(cost.labor + cost.material + cost.equipment),
      kpis: T.kpi_templates.filter(kp => kp.operation === line.operation).map(kp => ({ name: kp.name, target: kp.target, unit: kp.unit, direction: kp.direction, auto_key: kp.auto_key })), exceptions };
    plan.training = await trainingNeeds(plan);
    plans.push(plan);
  }

  // Reorder-level replenishment for stock items not already covered by a shortage line
  const shortIds = new Set(plans.flatMap(p => p.materials.filter(m => m.short).map(m => m.item_id)));
  const replenishment = T.items.filter(it => num(it.reorder_level) > 0 && !shortIds.has(it.id) && num(it.on_hand) - (allocated[it.id] || 0) <= num(it.reorder_level))
    .map(it => ({ item_id: it.id, code: it.code, name: it.name, uom: it.uom, projected: num(it.on_hand) - (allocated[it.id] || 0), reorder_level: num(it.reorder_level),
      order_qty: Math.max(num(it.reorder_qty), num(it.min_order_qty), 1), order_by: today(), need_date: addDays(today(), num(it.lead_time_days)) }));

  return db.insert('mrp_runs', { run_no: await db.nextNo('mrp_runs', 'run_no', 'MRP-'), run_date: now(), status: 'draft', result: { plans, replenishment, by: user.name } });
}

export async function approveMrp(id, user) {
  const run = await db.get('mrp_runs', id) || fail(404, 'MRP run not found');
  if (run.status !== 'draft') fail(400, `Run is already ${run.status}`);
  return db.update('mrp_runs', id, { status: 'approved', approved_by: user.name });
}

// Firming turns the plan into live projects and triggers procurement + training generation.
export async function firmMrp(id, user) {
  const run = await db.get('mrp_runs', id) || fail(404, 'MRP run not found');
  if (run.status !== 'approved') fail(400, 'Only an approved MRP run can be firmed');
  const reqs = [];
  for (const plan of run.result.plans) {
    const mps = await db.get('mps_lines', plan.mps_id);
    if (!mps || mps.status === 'planned') continue;
    const project = await db.insert('projects', { code: await db.nextNo('projects', 'code', 'PRJ-'), name: plan.name, customer_id: plan.customer_id, well_id: plan.well_id, so_id: plan.so_id,
      operation: plan.operation, machine_id: plan.machine?.id, start_date: plan.start_date, end_date: plan.end_date, status: 'planned', budget: plan.budget, mrp_run_id: id });
    plan.project_id = project.id; plan.project_code = project.code;
    await db.insert('project_activities', plan.activities.map(a => ({ ...a, project_id: project.id, actual_hours: 0, pct_complete: 0, status: 'pending' })));
    await db.insert('project_materials', plan.materials.map(m => ({ project_id: project.id, item_id: m.item_id, qty_required: m.required, qty_issued: 0, need_date: m.need_date })));
    await db.insert('project_manning', plan.crew.map(c => ({ project_id: project.id, position: c.position, employee_id: c.employee_id, start_date: plan.start_date, end_date: plan.end_date, status: c.status })));
    await db.insert('project_kpis', plan.kpis.map(kp => ({ ...kp, project_id: project.id })));
    for (const m of plan.materials.filter(m => m.short)) reqs.push({ item_id: m.item_id, description: m.name, qty: m.order_qty, need_date: m.need_date, order_by: m.order_by, project_id: project.id, mrp_run_id: id, reason: 'MRP shortage', status: 'open' });
    if (!plan.machine) reqs.push({ description: `Machine for ${plan.operation}: API ${plan.api_code || 'n/a'}, ${plan.depth_ft} ft, ${plan.flow_gpm} gpm (${plan.start_date} to ${plan.end_date})`, qty: 1, need_date: plan.start_date, order_by: today(), project_id: project.id, mrp_run_id: id, reason: 'machine requirement', status: 'open' });
    await db.update('mps_lines', mps.id, { status: 'planned', mrp_run_id: id, machine_id: plan.machine?.id || mps.machine_id });
    if (plan.so_id) await db.update('sales_orders', plan.so_id, { status: 'planned' });
  }
  for (const r of run.result.replenishment) reqs.push({ item_id: r.item_id, description: r.name, qty: r.order_qty, need_date: r.need_date, order_by: r.order_by, mrp_run_id: id, reason: 'reorder level', status: 'open' });
  await db.insert('requisitions', reqs);
  await db.update('mrp_runs', id, { status: 'firmed', firmed_by: user.name, result: run.result });
  const rfqs = await generateRfqs(id);
  const training = await generateTraining(id);
  await db.insert('notifications', [
    { role: 'procurement_manager', title: `MRP ${run.run_no} firmed`, body: `${reqs.length} requisitions and ${rfqs.created} RFQs were generated.`, kind: 'info', ref_table: 'mrp_runs', ref_id: id },
    { role: 'hr_head', title: `MRP ${run.run_no} firmed`, body: `${training.created} training sessions were scheduled for assigned crew.`, kind: 'info', ref_table: 'mrp_runs', ref_id: id },
  ]);
  return { projects: run.result.plans.map(p => p.project_code).filter(Boolean), requisitions: reqs.length, rfqs: rfqs.created, training: training.created };
}
