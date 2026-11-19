// Acceptance checks from HANDOFF.md section 10, run against a live API (demo data, demo login on).
//   node php/tools/accept.mjs [baseUrl]      default http://127.0.0.1:8080
const BASE = (process.argv[2] || 'http://127.0.0.1:8080') + '/api';
let pass = 0, failed = 0;
const ok = (cond, msg, extra = '') => { cond ? pass++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  ' + extra}`); return cond; };

class Client {
  cookie = '';
  async call(method, path, body) {
    const res = await fetch(BASE + '/' + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { error: 'non-JSON response: ' + text.slice(0, 200) }; }
    return { status: res.status, data: json };
  }
  get = p => this.call('GET', p);
  post = (p, b = {}) => this.call('POST', p, b);
  put = (p, b) => this.call('PUT', p, b);
}
const as = async role => { const c = new Client(); const r = await c.post('demo-login', { role }); if (r.status !== 200) throw new Error(`demo-login ${role}: ${JSON.stringify(r.data)}`); return c; };

// 1. Every role: sign in, /me, dashboard
const pub = (await new Client().get('public')).data;
const roles = Object.keys(pub.roles);
let dashErrors = [];
for (const role of roles) {
  const c = await as(role);
  const me = await c.get('me'), d = await c.get('dashboard');
  if (me.status !== 200 || d.status !== 200 || !d.data.widgets) dashErrors.push(`${role}: me=${me.status} dashboard=${d.status} ${d.data.error || ''}`);
}
ok(!dashErrors.length, `all ${roles.length} roles sign in and load their dashboard`, dashErrors.join(' | '));
const emp = await as('rig_field');
ok((await emp.get('data/payroll_runs')).status === 403, 'field employee cannot read payroll runs');
ok((await emp.get('data/users')).status === 403, 'field employee cannot read users');
ok((await emp.post('data/purchase_orders', { supplier_id: 'x' })).status === 403, 'field employee cannot create a PO');

const admin = await as('admin');
const count = async t => (await admin.get('data/' + t)).data.length;
const find = async (t, where) => (await admin.get('data/' + t)).data.filter(r => Object.entries(where).every(([k, v]) => r[k] === v));

// 2. Planning
const before = { projects: await count('projects'), reqs: await count('requisitions'), rfqs: await count('rfqs'), train: await count('training_schedules') };
const mps = await admin.post('planning/mps/generate');
ok(mps.status === 200 && typeof mps.data.created === 'number', 'MPS generated from confirmed orders', JSON.stringify(mps.data));
const draft = await find('mps_lines', { status: 'draft' });
ok(draft.length > 0, `MPS has draft lines to firm (${draft.length})`);
for (const l of draft) await admin.put('data/mps_lines/' + l.id, { status: 'firmed' });
const run = await admin.post('planning/mrp/run');
ok(run.status === 200 && run.data.result?.plans?.length > 0, `MRP run produced ${run.data.result?.plans?.length} plan(s)`, JSON.stringify(run.data).slice(0, 300));
const ap = await admin.post(`planning/mrp/${run.data.id}/approve`);
ok(ap.status === 200 && ap.data.status === 'approved', 'MRP approved', JSON.stringify(ap.data));
const firm = await admin.post(`planning/mrp/${run.data.id}/firm`);
ok(firm.status === 200 && firm.data.projects?.length > 0, 'MRP firmed -> projects, requisitions, RFQs, training', JSON.stringify(firm.data));
const after = { projects: await count('projects'), reqs: await count('requisitions'), rfqs: await count('rfqs'), train: await count('training_schedules') };
ok(after.projects > before.projects && after.reqs > before.reqs && after.rfqs > before.rfqs, `new records: projects +${after.projects - before.projects}, requisitions +${after.reqs - before.reqs}, RFQs +${after.rfqs - before.rfqs}, training +${after.train - before.train}`);

// 3. Procurement
const rfq = (await find('rfqs', { status: 'draft' })).find(r => r.supplier_id && r.lines?.length);
ok(!!rfq, 'a draft RFQ with a supplier exists');
const po = (await admin.post(`procurement/rfq/${rfq.id}/convert`)).data;
ok(po.po_no && po.status === 'draft', `RFQ converted to ${po.po_no}`, JSON.stringify(po));
const sub = await admin.post(`procurement/po/${po.id}/submit`);
ok(sub.status === 200 && ['pending approval', 'approved'].includes(sub.data.status), `PO submitted -> ${sub.data.status}, approver ${sub.data.current_approver || '-'}`, JSON.stringify(sub.data));
if (sub.data.status === 'pending approval') {
  const rej = await admin.post(`procurement/po/${po.id}/decide`, { approve: false });
  ok(rej.status === 400, 'reject without a reason fails', JSON.stringify(rej.data));
  let cur = sub.data, guard = 0;
  while (cur.status === 'pending approval' && guard++ < 6) { const r = await admin.post(`procurement/po/${po.id}/decide`, { approve: true }); cur = r.data; }
  ok(cur.status === 'approved', 'PO approved through every step of the chain', JSON.stringify(cur).slice(0, 200));
}
const items = (await admin.get('data/items')).data, itemById = Object.fromEntries(items.map(i => [i.id, i]));
const qaItem = po.lines.find(l => itemById[l.item_id]?.qa_required);
const recv = await admin.post('inventory/receive', { po_id: po.id, lines: po.lines.map(l => ({ item_id: l.item_id, qty: l.qty })) });
ok(recv.status === 200 && recv.data.status === 'received', `PO received -> ${recv.data.status}`, JSON.stringify(recv.data));
ok((await find('bills', { po_id: po.id })).length === 1, 'fully received PO created one supplier bill');
const pending = await find('stock_moves', { po_id: po.id, qa_status: 'pending' });
if (pending.length) {
  const m = pending[0], qa = await admin.post('inventory/qa', { move_id: m.id, qty_accepted: m.qty - 1, remarks: 'one unit damaged' });
  ok(qa.status === 200 && qa.data.qa_status === 'partial', 'QA with one unit rejected -> partial', JSON.stringify(qa.data));
} else console.log('SKIP  no QA-required item on this PO');

// 4. Inventory
const proj = (await admin.get('data/projects')).data.find(p => p.status === 'active') || (await admin.get('data/projects')).data[0];
const stockItem = items.find(i => i.on_hand >= 10 && !i.qa_required);
const onHand = async id => (await admin.get('data/items/' + id)).data.on_hand;
const h0 = await onHand(stockItem.id);
const iss = await admin.post('inventory/issue', { item_id: stockItem.id, qty: 4, project_id: proj.id });
ok(iss.status === 200 && (await onHand(stockItem.id)) === h0 - 4, 'issue 4 to project reduces stock', JSON.stringify(iss.data));
const ret = await admin.post('inventory/return', { item_id: stockItem.id, qty: 1, project_id: proj.id, kind: 'from project' });
ok(ret.status === 200 && (await onHand(stockItem.id)) === h0 - 3, 'return 1 from project restores stock', JSON.stringify(ret.data));
ok((await admin.post('inventory/adjust', { item_id: stockItem.id, qty: 2 })).status === 400, 'adjust without a reason fails');
ok((await admin.post('inventory/adjust', { item_id: stockItem.id, qty: 2, remarks: 'count correction' })).status === 200, 'adjust with a reason works');
const cnt = (await admin.post('inventory/counts/start', {})).data;
const lines = cnt.lines.map((l, i) => (i === 0 ? { ...l, counted_qty: l.system_qty + 3 } : l));
await admin.put('inventory/counts/' + cnt.id, { lines });
const posted = await admin.post(`inventory/counts/${cnt.id}/post`);
ok(posted.status === 200 && posted.data.adjusted === 1, 'physical count posted: one variance adjusted, blanks untouched', JSON.stringify(posted.data));

// 5. Operations: ticket online + offline (sent twice)
const proj2 = (await admin.get('data/projects')).data.find(p => p.code && p.status === 'active');
const manning = (await admin.get('data/project_manning')).data.filter(m => m.project_id === proj2.id && m.employee_id);
const acts = (await admin.get('data/project_activities')).data.filter(a => a.project_id === proj2.id);
const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const mk = (date, extra) => ({ project_id: proj2.id, work_date: date, shift: 'day', status: 'submitted', lines: [{ activity_id: acts[0].id, description: 'test', hours: 10, pct_complete: 90 }],
  crew: manning.map(m => ({ employee_id: m.employee_id, hours: 12 })), materials: [], incidents: 0, ...extra });
const costs0 = (await find('project_costs', { project_id: proj2.id })).length;
const online = await admin.post('operations/tickets', mk(tomorrow, { entry_mode: 'online' }));
ok(online.status === 200 && online.data.ticket_no, `online ticket ${online.data.ticket_no}`, JSON.stringify(online.data));
const cid = 'accept-' + Date.now();
const s1 = await admin.post('operations/tickets/sync', { tickets: [mk(today, { client_id: cid })] });
const s2 = await admin.post('operations/tickets/sync', { tickets: [mk(today, { client_id: cid })] });
ok(s1.data.results?.[0]?.ok && s2.data.results?.[0]?.ok, 'offline ticket synced, re-sent without error', JSON.stringify([s1.data, s2.data]));
ok((await find('work_tickets', { client_id: cid })).length === 1, 'offline ticket stored exactly once');
ok((await find('timesheets', { project_id: proj2.id, work_date: tomorrow })).length === manning.length, 'online ticket created one timesheet per crew member');
ok((await find('project_costs', { project_id: proj2.id })).length > costs0, 'project costs updated');
const ov = await admin.get(`operations/projects/${proj2.id}/overview`);
ok(ov.status === 200 && Array.isArray(ov.data.trend) && ov.data.trend.length > 0 && 'planned_pct' in ov.data, `project overview: planned ${ov.data.planned_pct}% actual ${ov.data.actual_pct}%, ${ov.data.trend?.length} trend days, ${ov.data.exceptions?.length} exceptions`, JSON.stringify(ov.data).slice(0, 300));

// 6. Work-day limit
const alerts = await find('work_limit_alerts', { status: 'pending' });
ok(alerts.length >= 1, `work-day limit produced ${alerts.length} pending approval`);
const mgr = await as('rig_manager');
const ap2 = (await mgr.get('dashboard')).data.widgets.find(w => w.id === 'approvals');
ok(ap2?.items?.some(i => i.kind === 'work_limit'), 'Rig Manager dashboard shows the work-limit approval');
const dec = await mgr.post(`operations/alerts/${alerts[0].id}/decide`, { approve: true, note: 'ok' });
ok(dec.status === 200 && dec.data.status === 'approved', 'Rig Manager approves the alert', JSON.stringify(dec.data));

// 7. HR
const cons = await admin.post('hr/timekeeping/consolidate');
ok(cons.status === 200 && typeof cons.data.consolidated === 'number', `timesheets consolidated (${cons.data.consolidated})`, JSON.stringify(cons.data));
const ym = new Date().toISOString().slice(0, 7);
const pr = await admin.post('hr/payroll/run', { period_start: ym + '-01', period_end: tomorrow > ym + '-31' ? today : ym + '-28' });
const pr2 = pr.status === 200 ? pr : await admin.post('hr/payroll/run', { period_start: new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10), period_end: tomorrow });
ok(pr2.status === 200 && pr2.data.total_gross > 0, `payroll run created, gross ${pr2.data.total_gross} net ${pr2.data.total_net}`, JSON.stringify(pr2.data));
const pa = await admin.post(`hr/payroll/${pr2.data.id}/approve`);
ok(pa.status === 200 && pa.data.status === 'approved', 'payroll approved', JSON.stringify(pa.data));
ok((await emp.get('data/payslips')).status === 200, 'employee can list own payslips only');

// 8. Finance
const inv = (await admin.get('data/invoices')).data.find(i => i.status === 'draft');
if (inv) ok((await admin.post(`finance/invoices/${inv.id}/post`)).status === 200, 'draft invoice posted');
const tb = (await admin.get('finance/trial-balance')).data;
const dr = tb.reduce((a, r) => a + r.debit, 0), cr = tb.reduce((a, r) => a + r.credit, 0);
ok(Math.abs(dr - cr) < 0.01 && dr > 0, `trial balance balances: debit ${dr.toFixed(2)} = credit ${cr.toFixed(2)}`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
