// HR: training matrix compliance, timekeeping, payroll.
import { actionBtn, addDays, api, badge, can, card, confirmBox, field, fmtDate, fmtMoney, fmtNum, h, invalidate, names, page, rows, simpleTable, toast, today } from '../core.js';

// Training schedules from the latest approved-and-firmed MRP run
export async function generateFromMrp() {
  const run = (await rows('mrp_runs')).filter(r => r.status === 'firmed').pop();
  if (!run) throw new Error('There is no approved and firmed MRP run yet.');
  const r = await api('/hr/training/generate', { body: { run_id: run.id } });
  return r.created ? `${r.created} training session(s) scheduled from ${run.run_no}` : `All crew in ${run.run_no} are already compliant or scheduled`;
}
export async function completeTraining(s) {
  const course = (await rows('training_courses')).find(c => c.id === s.course_id);
  const done = s.end_date || today();
  await api('/data/training_records', { body: { employee_id: s.employee_id, course_id: s.course_id, completed_date: done, expiry_date: course?.validity_months ? addDays(done, course.validity_months * 30) : null, certificate_no: `${course?.code || 'TR'}-${Date.now().toString().slice(-6)}` } });
  await api(`/data/training_schedules/${s.id}`, { method: 'PUT', body: { status: 'completed' } });
  return 'Training completed and certificate recorded';
}

export async function compliancePage(root) {
  const { courses, rows: emps } = await api('/hr/training/compliance');
  const pillars = [...new Set(courses.map(c => c.pillar))];
  const SYM = { valid: '✓', expiring: '!', expired: '✕', missing: '–', scheduled: 'S' };
  let pillar = pillars[0], q = '';
  const body = h('div');
  const draw = () => {
    const cs = courses.filter(c => c.pillar === pillar);
    const list = emps.filter(e => (!q || `${e.name} ${e.position}`.toLowerCase().includes(q)) && cs.some(c => e.cells[c.id]));
    body.replaceChildren(list.length ? h('div.table-wrap', h('table.matrix', h('thead', h('tr', h('th.n', 'Employee'), h('th', 'Overall'), cs.map(c => h('th.c', { title: `${c.name} - ${c.standard || ''}` }, `${c.code} ${c.name}`)))),
      h('tbody', list.map(e => h('tr', h('td.n', h('strong', e.name), h('div.muted', e.position)), h('td', badge(`${e.pct}%`, e.pct === 100 ? 'good' : e.pct >= 70 ? 'warn' : 'bad')),
        cs.map(c => { const x = e.cells[c.id]; return h('td', x ? h('span.cell', { class: x.state, title: `${x.state}${x.expiry ? ` · expires ${x.expiry}` : ''}${x.scheduled ? ` · training ${x.scheduled}` : ''}` }, SYM[x.state]) : ''); })))))) : h('div.empty', 'No employees require courses in this pillar'));
  };
  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Training pillar' }, pillars.map(p => h('button', { type: 'button', role: 'tab', class: p === pillar ? 'on' : '', onclick: e => { pillar = p; tabs.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); draw(); } }, p)));
  const gaps = emps.reduce((a, e) => a + Object.values(e.cells).filter(c => ['missing', 'expired'].includes(c.state)).length, 0);
  root.replaceChildren(...page('Training Matrix', [h('input.search', { type: 'search', placeholder: 'Search employee or position…', oninput: e => { q = e.target.value.toLowerCase(); draw(); } }),
    can('hr') ? actionBtn('Generate from MRP', async () => { toast(await generateFromMrp(), 'good'); invalidate(); compliancePage(root); }, 'primary') : null],
  h('div.banner', { class: gaps ? 'warn' : 'good' }, `${gaps} open training gap(s) across ${emps.length} employees. Requirements come from the position matrix; "All Personnel" courses apply to everyone.`),
  tabs, card(null, h('div.row', Object.entries(SYM).map(([k, s]) => h('span.row', { style: { gap: '4px' } }, h('span.cell', { class: k }, s), h('span.muted', k)))), body)));
  draw();
}

export async function timekeepingPage(root) {
  const from = h('input', { type: 'date', value: addDays(today(), -30) }), to = h('input', { type: 'date', value: today() });
  const out = h('div');
  const run = async () => {
    const s = await api(`/hr/timekeeping/summary?from=${from.value}&to=${to.value}`);
    const pending = s.rows.reduce((a, r) => a + r.unconsolidated, 0);
    out.replaceChildren(h('div.banner', { class: pending ? 'warn' : 'good' }, pending ? `${pending} timesheet line(s) captured from offline work tickets are waiting for consolidation.` : 'All timesheets are consolidated. Online work tickets consolidate in real time.',
      ` Maximum consecutive working days: ${s.limit} (change in Settings › Parameters › max_work_days).`),
    card('Accumulated worked hours and days', null, simpleTable([{ label: 'Employee', key: 'name' }, { label: 'Position', key: 'position' }, { label: 'Regular h', get: r => fmtNum(r.regular_hours), num: 1 }, { label: 'Overtime h', get: r => fmtNum(r.ot_hours), num: 1 },
      { label: 'Days worked', key: 'days', num: 1 }, { label: 'Last worked', get: r => fmtDate(r.last_worked) }, { label: 'Consecutive days', get: r => badge(String(r.consecutive_days), r.consecutive_days > s.limit ? 'bad' : r.consecutive_days >= s.limit - 2 ? 'warn' : 'good') },
      { label: 'To consolidate', get: r => r.unconsolidated || '', num: 1 }], s.rows, { empty: 'No timesheets in this period' })));
  };
  root.replaceChildren(...page('Timekeeping', [h('div.row', from, to), actionBtn('Show', run), can('hr') ? actionBtn('Consolidate now', async () => { const r = await api('/hr/timekeeping/consolidate', { body: {} }); invalidate(); toast(`${r.consolidated} timesheet line(s) consolidated`, 'good'); await run(); }, 'primary') : null], out));
  await run();
}

export async function payrollPage(root, id, base) {
  const runs = (await rows('payroll_runs')).slice().reverse();
  if (!id) {
    const d = new Date(), first = new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10);
    const ps = h('input', { type: 'date', value: first }), pe = h('input', { type: 'date', value: today() });
    return root.replaceChildren(...page('Payroll', can('hr') ? actionBtn('Calculate payroll', async () => { const r = await api('/hr/payroll/run', { body: { period_start: ps.value, period_end: pe.value } }); invalidate(); location.hash = `${base}/${r.id}`; }, 'primary') : null,
      can('hr') ? card('New payroll run', null,
        h('div.body', h('div.fields', field('Period start', ps), field('Period end', pe)), h('p.muted', 'Pay is calculated from consolidated timesheets (regular and overtime hours), approved paid leaves and daily field allowances for the period.'))) : null,
      h('div', { style: { height: '14px' } }),
      card('Payroll runs', null, simpleTable([{ label: 'Run', key: 'name' }, { label: 'Gross', get: r => fmtNum(r.total_gross), num: 1 }, { label: 'Net', get: r => fmtNum(r.total_net), num: 1 }, { label: 'Status', get: r => badge(r.status) }],
        runs, { onRow: r => { location.hash = `${base}/${r.id}`; }, empty: 'No payroll runs yet' }))));
  }
  const run = runs.find(r => r.id === id);
  if (!run) throw new Error('Payroll run not found');
  const [slips, emp] = await Promise.all([rows('payslips', { run_id: id }), names('employees')]);
  const n = k => ({ label: k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), get: s => fmtNum(s[k]), num: 1 });
  root.replaceChildren(...page([h('a', { href: base }, 'Payroll'), h('span.sep', '/'), run.name], [badge(run.status),
    run.status === 'draft' && can('hr', 'finance') ? h('button.btn.primary', { onclick: () => confirmBox('Approving marks the timesheets as paid and posts the payroll journal entry.', 'Approve payroll', async () => { await api(`/hr/payroll/${id}/approve`, { body: {} }); invalidate(); toast('Payroll approved and posted', 'good'); payrollPage(root, id, base); }) }, 'Approve & post') : null,
    run.status === 'draft' && can('hr') ? h('button.btn.danger', { onclick: () => confirmBox('Delete this draft payroll run?', 'Delete', async () => { await api(`/data/payroll_runs/${id}`, { method: 'DELETE' }); invalidate(); location.hash = base; }) }, 'Delete') : null],
  card(`${slips.length} payslips · gross ${fmtMoney(run.total_gross, 2)} · net ${fmtMoney(run.total_net, 2)}`, null, simpleTable([{ label: 'Employee', get: s => emp[s.employee_id] }, n('days_worked'), n('regular_hours'), n('ot_hours'), n('leave_days'),
    n('basic_pay'), n('ot_pay'), n('leave_pay'), n('allowances'), n('gross_pay'), n('deductions'), n('net_pay')], slips))));
}
