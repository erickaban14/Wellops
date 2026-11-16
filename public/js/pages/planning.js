// Planning: machine selection by API/depth/flow/operation, MRP runs, availability board.
import { actionBtn, addDays, api, badge, can, card, confirmBox, field, fmtDT, fmtNum, h, invalidate, names, page, rows, select, simpleTable, toast, today } from '../core.js';

const OPS = ['drilling', 'workover', 'surface pumping'];

export async function machineSelection(root) {
  const f = { api_code: h('input', { placeholder: 'e.g. 4F, 7K' }), depth_ft: h('input', { type: 'number', placeholder: 'ft' }), flow_gpm: h('input', { type: 'number', placeholder: 'gpm' }),
    operation: select(['', ...OPS], 'drilling'), start: h('input', { type: 'date', value: addDays(today(), 14) }), end: h('input', { type: 'date', value: addDays(today(), 28) }) };
  const out = h('div.stack');
  const run = async () => {
    const r = await api('/planning/select-machine', { body: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) });
    out.replaceChildren(
      r.best ? h('div.banner.good', h('strong', `Best selection: ${r.best.machine.code} · ${r.best.machine.name}`), ` - fit score ${r.best.score}, loaded to ${r.best.load_pct}% of its rating and free for the requested dates.`)
        : h('div.banner.bad', 'No capable machine is free for these parameters and dates. MRP would raise a rental/purchase requisition.'),
      card('Ranked machines', null, r.ranked.map(c => h('div.cand', { class: c.machine.id === r.best?.machine.id ? 'best' : c.eligible ? '' : 'no' },
        h('div', h('strong', `${c.machine.code} · ${c.machine.name}`), ' ', c.machine.id === r.best?.machine.id ? badge('best fit', 'good') : !c.eligible ? badge('not capable', 'bad') : !c.available ? badge('not available', 'warn') : badge('capable', 'info'),
          h('div.checks', { style: { marginTop: '6px' } }, c.pass.map(t => badge(`✓ ${t}`, 'good')), c.failed.map(t => badge(`✕ ${t}`, 'bad')), c.conflicts.map(t => badge(`⚠ ${t}`, 'warn'))),
          c.machine.accessories ? h('div.muted', { style: { marginTop: '6px' } }, `Accessory tools: ${c.machine.accessories}`) : null,
          c.manuals.length ? h('div', { style: { marginTop: '6px' } }, 'Manuals: ', c.manuals.map(m => (m.has_file ? h('a.badge.info', { href: `/api/documents/${m.id}/file`, target: '_blank', rel: 'noopener' }, m.title) : h('span.badge', m.title)))) : null),
        h('div', h('div.score', c.eligible ? c.score : '–'), h('div.muted.right', c.eligible ? 'fit score' : ''))))),
      r.standards.length ? card('Applicable API standards', null, simpleTable([{ label: 'Code', key: 'code' }, { label: 'Title', key: 'title' }, { label: 'Scope', key: 'scope' }], r.standards)) : null);
  };
  root.replaceChildren(...page('Machine Selection', null,
    card('Selection criteria', actionBtn('Find best machine', run, 'primary'), h('div.body', h('div.fields', field('API code(s)', f.api_code), field('Well depth (ft)', f.depth_ft), field('Target flow rate (gpm)', f.flow_gpm),
      field('Target operation', f.operation), field('Needed from', f.start), field('Needed to', f.end)))), h('div', { style: { height: '14px' } }), out));
  await run();
}

const gantt = (acts, start, end) => {
  const t0 = new Date(start).getTime(), span = new Date(end).getTime() - t0 || 1;
  return h('div.gantt', acts.map(a => h('div.g-row', h('span', a.name),
    h('div.track', h('i', { style: { left: `${(new Date(a.planned_start) - t0) / span * 100}%`, width: `${(new Date(a.planned_end) - new Date(a.planned_start)) / span * 100}%` }, title: `${fmtDT(a.planned_start)} → ${fmtDT(a.planned_end)}` })),
    h('span.muted.num.right', `${Math.floor(a.planned_hours / 24)}d ${a.planned_hours % 24}h`))));
};
export { gantt };

function planCard(p) {
  const tabs = {
    Activities: () => h('div.body', h('div.muted', { style: { marginBottom: '8px' } }, `${fmtDT(p.activities[0]?.planned_start)} → ${fmtDT(p.activities.at(-1)?.planned_end)} · total ${p.duration} (${p.total_hours} h)`),
      gantt(p.activities, p.activities[0]?.planned_start, p.activities.at(-1)?.planned_end)),
    Materials: () => simpleTable([{ label: 'Item', get: m => `${m.code} · ${m.name}` }, { label: 'Type', key: 'category' }, { label: 'Required', get: m => `${fmtNum(m.required)} ${m.uom || ''}`, num: 1 }, { label: 'From stock', get: m => fmtNum(m.from_stock), num: 1 },
      { label: 'Shortage', get: m => (m.short ? badge(fmtNum(m.short), 'bad') : badge('covered', 'good')) }, { label: 'To order', get: m => (m.order_qty ? fmtNum(m.order_qty) : ''), num: 1 }, { label: 'Order by', get: m => m.order_by || '' }], p.materials),
    Manning: () => simpleTable([{ label: 'Position', key: 'position' }, { label: 'Assigned', get: c => c.name || badge('shortage', 'bad') },
      { label: 'Availability check', get: c => (c.blocked.length ? h('span.muted', `Skipped: ${c.blocked.join('; ')}`) : c.name ? 'Free of leave, training and other projects' : 'No employee with this position') }], p.crew),
    Machine: () => h('div.body', p.machine ? [h('strong', `${p.machine.code} · ${p.machine.name}`), ' ', badge(`fit ${p.machine.score}`, 'good'), h('div.muted', { style: { margin: '6px 0 10px' } }, `Accessory tools: ${p.machine.accessories || 'none listed'}`)] : h('div.banner.bad', 'No machine available'),
      simpleTable([{ label: 'Candidate', get: a => `${a.code} · ${a.name}` }, { label: 'Fit', key: 'score', num: 1 }, { label: 'Availability (PM plans & deployments)', get: a => (a.available ? badge('free', 'good') : h('span', badge('conflict', 'warn'), ' ', a.conflicts.join('; '))) }], p.machine_alternatives)),
    Training: () => simpleTable([{ label: 'Employee', key: 'name' }, { label: 'Course', key: 'course' }, { label: 'Pillar', get: t => t.pillar?.split(' - ')[0] }, { label: 'Days', key: 'duration_days', num: 1 }, { label: 'Reason', key: 'reason' }], p.training, { empty: 'All assigned crew are compliant for this project' }),
    KPIs: () => simpleTable([{ label: 'KPI', key: 'name' }, { label: 'Target', get: k => `${k.direction} ${k.target} ${k.unit || ''}` }, { label: 'Measured', get: k => (k.auto_key ? 'Automatically from work tickets' : 'Manual entry') }], p.kpis),
  };
  const body = h('div'), bar = h('div.tabs', { style: { margin: 0, padding: '0 8px' } });
  const show = name => { body.replaceChildren(tabs[name]()); bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.textContent.startsWith(name))); };
  const counts = { Materials: p.materials.filter(m => m.short).length, Manning: p.crew.filter(c => !c.employee_id).length, Training: p.training.length };
  bar.append(...Object.keys(tabs).map(n => h('button', { onclick: () => show(n) }, n, counts[n] ? ` (${counts[n]})` : '')));
  const el = card(`${p.project_code ? `${p.project_code} · ` : ''}${p.name}`, [badge(`${p.start_date} → ${p.end_date}`, 'info'), badge(p.duration), badge(`Budget ${fmtNum(p.budget, 0)}`)],
    p.exceptions.length ? h('div.body', { style: { paddingBottom: 0 } }, p.exceptions.map(e => h('div.banner.warn', { style: { marginBottom: '6px' } }, e))) : null, bar, body);
  show('Activities');
  return el;
}

export async function mrpPage(root, id, base) {
  const runs = (await rows('mrp_runs')).slice().reverse();
  const act = (label, path, msg, cls) => actionBtn(label, async () => { const r = await api(path, { body: {} }); invalidate(); toast(typeof msg === 'function' ? msg(r) : msg, 'good'); if (r.id && !id) location.hash = `${base}/${r.id}`; else mrpPage(root, id, base); }, cls);
  if (!id) {
    const firmed = (await rows('mps_lines')).filter(l => l.status === 'firmed').length;
    return root.replaceChildren(...page('MRP Runs', can('planning') ? act('Run MPS / MRP', '/planning/mrp/run', 'MRP run complete - review, approve and firm', 'primary') : null,
      h('div.banner', `${firmed} firmed master-schedule line(s) waiting to be planned. A run produces the detailed plan: activities and timelines, materials, field manning, machine and accessory tools. Firming it creates the projects and automatically raises RFQs and training schedules.`),
      card(null, null, simpleTable([{ label: 'Run', key: 'run_no' }, { label: 'Date', get: r => fmtDT(r.run_date) }, { label: 'Projects', get: r => r.result?.plans?.length, num: 1 },
        { label: 'Exceptions', get: r => r.result?.plans?.reduce((a, p) => a + p.exceptions.length, 0), num: 1 }, { label: 'Approved by', key: 'approved_by' }, { label: 'Status', get: r => badge(r.status) }],
      runs, { onRow: r => { location.hash = `${base}/${r.id}`; }, empty: 'No MRP runs yet' }))));
  }
  const run = runs.find(r => r.id === id);
  if (!run) throw new Error('MRP run not found');
  const { plans, replenishment } = run.result;
  root.replaceChildren(...page([h('a', { href: base }, 'MRP Runs'), h('span.sep', '/'), run.run_no], can('planning') ? [
    run.status === 'draft' ? act('Approve plan', `/planning/mrp/${id}/approve`, 'Plan approved', 'primary') : null,
    run.status === 'approved' ? h('button.btn.primary', { onclick: () => confirmBox('Firming creates the projects, purchase requisitions, RFQs and training schedules. Continue?', 'Firm plan', async () => {
      const r = await api(`/planning/mrp/${id}/firm`, { body: {} }); invalidate();
      toast(`Firmed: ${r.projects.join(', ')} · ${r.requisitions} requisitions · ${r.rfqs} RFQs · ${r.training} trainings`, 'good'); mrpPage(root, id, base); }) }, 'Firm plan') : null] : null,
  h('div.stack', h('div.statusbar', ['draft', 'approved', 'firmed'].map(s => h('span', { class: s === run.status ? 'on' : '' }, s))), plans.map(planCard),
    replenishment.length ? card('Reorder-level replenishment', null, simpleTable([{ label: 'Item', get: r => `${r.code} · ${r.name}` }, { label: 'Projected stock', key: 'projected', num: 1 }, { label: 'Reorder level', key: 'reorder_level', num: 1 },
      { label: 'Order qty', get: r => `${fmtNum(r.order_qty)} ${r.uom || ''}`, num: 1 }, { label: 'Needed by', key: 'need_date' }], replenishment)) : null)));
}

export async function availabilityPage(root) {
  const from = h('input', { type: 'date', value: today() }), to = h('input', { type: 'date', value: addDays(today(), 45) });
  const out = h('div.stack');
  const KIND = { leave: 'warn', training: 'info', project: 'good', maintenance: 'bad' };
  const board = (title, list, sub) => card(title, null, h('div.board', list.map(r => h('div.b-row', h('div', h('strong', r.name), h('div.muted', sub(r))),
    h('div.checks', r.blocks.length ? r.blocks.map(b => badge(`${b.kind}: ${b.text} (${b.from} → ${b.to})`, KIND[b.kind])) : badge('available', ''))))));
  const run = async () => {
    const r = await api(`/planning/availability?start=${from.value}&end=${to.value}`);
    const busy = r.people.filter(p => p.blocks.length);
    out.replaceChildren(h('div.banner', `${r.people.length - busy.length} of ${r.people.length} employees and ${r.fleet.filter(m => !m.blocks.length).length} of ${r.fleet.length} machines are fully available in this period.`),
      board('Machines - preventive maintenance and deployments', r.fleet, m => m.operation), board('Manpower - leaves, trainings and assignments', [...busy, ...r.people.filter(p => !p.blocks.length && p.position !== 'Office Staff')], p => p.position));
  };
  root.replaceChildren(...page('Availability check', [h('div.row', from, to), actionBtn('Check', run, 'primary')], out));
  await run();
}
