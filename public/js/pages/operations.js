// Project operations: real-time project overview and Daily Work Tickets (online + offline).
import { actionBtn, api, badge, can, card, confirmBox, field, fmtDT, fmtNum, h, invalidate, names, page, rows, select, simpleTable, state, toast, today } from '../core.js';
import { lineEditor } from '../views.js';
import { progress } from './dashboard.js';
import { dequeue, enqueue, loadRef, queued, saveRef } from '../offline.js';

// ---------- Project overview: planned vs actual, exceptions, KPIs, accumulated cost ----------
export async function projectPage(root, id, base) {
  const [o, emp, item, mach] = await Promise.all([api(`/operations/projects/${id}/overview`), names('employees'), names('items'), names('machines')]);
  const p = o.project, t0 = new Date(o.activities[0]?.planned_start || p.start_date).getTime(), span = new Date(o.activities.at(-1)?.planned_end || p.end_date).getTime() - t0 || 1;
  const tile = (t, v, s, cls = '') => h('div.card.kpi', { class: cls }, h('div.t', t), h('div.v', v), s ? h('div.s', s) : null);
  const complete = () => confirmBox(`Mark ${p.code} as completed and release its machine?`, 'Complete project', async () => {
    await api(`/data/projects/${id}`, { method: 'PUT', body: { status: 'completed' } });
    if (p.machine_id) await api(`/data/machines/${p.machine_id}`, { method: 'PUT', body: { status: 'available' } }).catch(() => {});
    if (p.so_id) await api(`/data/sales_orders/${p.so_id}`, { method: 'PUT', body: { status: 'done' } }).catch(() => {});
    invalidate(); toast('Project completed', 'good'); projectPage(root, id, base);
  });
  root.replaceChildren(...page([h('a', { href: base }, 'Projects'), h('span.sep', '/'), `${p.code} · ${p.name}`], [badge(p.status),
    can('operations') && p.status !== 'completed' ? h('a.btn.primary', { href: `#/operations/work_tickets/new?project=${id}` }, 'New work ticket') : null,
    can('operations') && p.status === 'active' ? h('button.btn', { onclick: complete }, 'Complete') : null],
  h('div.stack',
    h('div.kpis', tile('Progress vs plan', `${o.actual_pct}%`, `Planned to date ${o.planned_pct}% (${o.deviation > 0 ? '+' : ''}${o.deviation} pts)`, o.deviation < -5 ? 'bad' : o.deviation < 0 ? 'warn' : 'good'),
      tile('Accumulated cost', fmtNum(o.cost, 0), `Budget ${fmtNum(o.budget, 0)} · ${o.budget ? Math.round(o.cost / o.budget * 100) : 0}% used`, o.cost > o.budget ? 'bad' : ''),
      tile('Hours worked', fmtNum(o.hours), `${o.npt} h non-productive`, o.npt ? 'warn' : 'good'), tile('Work tickets', String(o.tickets), `${p.start_date} → ${p.end_date}`),
      tile('Machine', (mach[p.machine_id] || 'None').split(' · ')[0], (mach[p.machine_id] || '').split(' · ')[1] || '')),
    card('Exceptions & deviations to date', o.exceptions.length ? badge(String(o.exceptions.length), 'bad') : badge('on plan', 'good'),
      o.exceptions.length ? o.exceptions.map(e => h('div.item', h('span.dot', { class: e.level, title: e.level }), h('span.badge', e.type), h('span.grow', e.text + (e.item_id ? ` - ${item[e.item_id]}` : '')))) : h('div.empty', 'No exceptions')),
    card('Activities: planned vs actual', h('span.muted', 'teal = plan · amber = actual progress'), h('div.body', h('div.gantt', o.activities.map(a => {
      const left = (new Date(a.planned_start) - t0) / span * 100, w = (new Date(a.planned_end) - new Date(a.planned_start)) / span * 100;
      return h('div.g-row', h('span', a.name), h('div.track', { title: `${fmtDT(a.planned_start)} → ${fmtDT(a.planned_end)}` }, h('i', { style: { left: `${left}%`, width: `${w}%`, opacity: .45 } }),
        h('i.act', { style: { left: `${left}%`, width: `${w * (Number(a.pct_complete) || 0) / 100}%` } })),
      h('span.num.right', { class: Number(a.actual_hours) > Number(a.planned_hours) * 1.1 ? '' : 'muted', style: { color: Number(a.actual_hours) > Number(a.planned_hours) * 1.1 ? 'var(--bad)' : '' } }, `${fmtNum(a.actual_hours)}/${a.planned_hours} h`));
    })))),
    h('div.widgets',
      card('KPIs', null, simpleTable([{ label: 'KPI', key: 'name' }, { label: 'Target', get: k => `${k.direction} ${k.target} ${k.unit || ''}` }, { label: 'Actual', get: k => (k.actual == null || k.actual === '' ? '–' : `${fmtNum(k.actual)} ${k.unit || ''}`), num: 1 },
        { label: 'Result', get: k => (k.ok == null ? badge('no data') : k.ok ? badge('on target', 'good') : badge('off target', 'bad')) }], o.kpis, { empty: 'No KPIs defined' })),
      card('Accumulated cost by category', h('a.btn.small', { href: '#/operations/project_costs' }, 'All entries'), simpleTable([{ label: 'Category', get: r => r[0] }, { label: 'Amount', get: r => fmtNum(r[1]), num: 1 }],
        [...Object.entries(o.cost_by_category), ['Total', o.cost], ['Budget', o.budget]])),
      card('Field manning', null, simpleTable([{ label: 'Position', key: 'position' }, { label: 'Employee', get: m => emp[m.employee_id] || badge('shortage', 'bad') }], o.manning)),
      card('Materials: required vs issued', null, simpleTable([{ label: 'Item', get: m => item[m.item_id] }, { label: 'Required', get: m => fmtNum(m.qty_required), num: 1 }, { label: 'Issued', get: m => fmtNum(m.qty_issued), num: 1 }], o.materials)))),
  h('div', { style: { marginTop: '10px' } }, progress(o.planned_pct, o.actual_pct))));
}

// ---------- Daily Work Tickets ----------
const SUPERVISORS = ['rig_supervisor', 'rig_manager', 'operations_head', 'admin'];
async function reference() {
  try {
    const [projects, activities, manning, employees, items] = await Promise.all(['projects', 'project_activities', 'project_manning', 'employees', 'items'].map(t => rows(t)));
    const ref = { projects: projects.filter(p => p.status !== 'completed').map(p => ({ id: p.id, code: p.code, name: p.name })),
      activities: activities.map(a => ({ id: a.id, project_id: a.project_id, seq: a.seq, name: a.name })), manning: manning.filter(m => m.employee_id).map(m => ({ project_id: m.project_id, employee_id: m.employee_id })),
      employees: Object.fromEntries(employees.filter(e => e.department === 'Operations' || e.department === 'Engineering').map(e => [e.id, `${e.name} (${e.position})`])), items: Object.fromEntries(items.map(i => [i.id, `${i.code} · ${i.name} (${i.uom || 'ea'})`])) };
    saveRef(ref);     // keep a copy on the device for offline entry
    return ref;
  } catch (e) {
    const ref = e.offline && loadRef();
    if (!ref) throw new Error('This device has no offline data yet. Open Daily Work Tickets once while online.');
    return ref;
  }
}

export async function ticketsPage(root, id, base) {
  if (id) return ticketForm(root, id, base);
  const ref = await reference();
  const P = Object.fromEntries(ref.projects.map(p => [p.id, p.code]));
  let tickets = [];
  try { tickets = (await rows('work_tickets')).slice().sort((a, b) => b.work_date.localeCompare(a.work_date) || String(b.ticket_no).localeCompare(a.ticket_no)); } catch (e) { if (!e.offline) throw e; }
  const q = queued();
  root.replaceChildren(...page('Daily Work Tickets', can('operations') ? h('a.btn.primary', { href: `${base}/new` }, 'New ticket') : null,
    state.offline ? h('div.banner.warn', 'Offline mode: tickets are saved on this device and synchronise automatically when the connection returns.') : null,
    q.length ? card(`Waiting to sync (${q.length})`, null, simpleTable([{ label: 'Project', get: t => P[t.project_id] }, { label: 'Date', key: 'work_date' }, { label: 'Shift', key: 'shift' }, { label: 'Saved', get: t => fmtDT(t.queued_at) }, { label: 'Status', get: () => badge('on device', 'warn') }],
      q, { onRow: t => { location.hash = `${base}/q-${t.client_id}`; } })) : null, q.length ? h('div', { style: { height: '12px' } }) : null,
    card(null, null, simpleTable([{ label: 'Ticket', key: 'ticket_no' }, { label: 'Project', get: t => P[t.project_id] || '' }, { label: 'Date', key: 'work_date' }, { label: 'Shift', key: 'shift' },
      { label: 'Hours', get: t => fmtNum((t.lines || []).reduce((a, l) => a + (Number(l.hours) || 0), 0)), num: 1 }, { label: 'Crew', get: t => (t.crew || []).length, num: 1 }, { label: 'Entry', get: t => badge(t.entry_mode) }, { label: 'Status', get: t => badge(t.status) }],
    tickets, { onRow: t => { location.hash = `${base}/${t.id}`; }, empty: state.offline ? 'Submitted tickets are shown when you are back online.' : 'No work tickets yet' }))));
}

async function ticketForm(root, rawId, base) {
  const [id, query] = rawId.split('?');
  const ref = await reference();
  let t;
  if (id === 'new') t = { client_id: crypto.randomUUID(), project_id: new URLSearchParams(query).get('project') || ref.projects[0]?.id, work_date: today(), shift: 'day', status: 'draft', incidents: 0 };
  else if (id.startsWith('q-')) t = queued().find(x => x.client_id === id.slice(2));
  else t = await api(`/data/work_tickets/${id}`);
  if (!t) throw new Error('Ticket not found');
  const onDevice = id.startsWith('q-'), readonly = t.status === 'approved' || !can('operations');
  const f = { project_id: select(ref.projects.map(p => [p.id, `${p.code} · ${p.name}`]), t.project_id, { disabled: readonly || (!!t.id) }), work_date: h('input', { type: 'date', value: t.work_date, disabled: readonly }),
    shift: select(['day', 'night'], t.shift, { disabled: readonly }), incidents: h('input', { type: 'number', min: 0, value: t.incidents ?? 0, disabled: readonly }), remarks: h('textarea', { value: t.remarks || '', disabled: readonly }) };
  const sections = h('div');
  let ed = {};
  const build = fresh => {
    const pid = f.project_id.value;
    const acts = Object.fromEntries(ref.activities.filter(a => a.project_id === pid).sort((a, b) => a.seq - b.seq).map(a => [a.id, a.name]));
    const crew = fresh || !t.crew ? ref.manning.filter(m => m.project_id === pid).map(m => ({ employee_id: m.employee_id, hours: 12 })) : t.crew;
    ed = {
      lines: lineEditor([['activity_id', 'ref', { ref: 'acts', label: 'Activity' }], ['description'], ['hours', 'number'], ['pct_complete', 'number', { label: '% Complete' }], ['depth_from', 'number', { label: 'Depth from (ft)' }], ['depth_to', 'number', { label: 'Depth to (ft)' }], ['npt', 'bool', { label: 'NPT' }]],
        fresh ? [{}] : t.lines || [{}], { acts }, readonly),
      crew: lineEditor([['employee_id', 'ref', { ref: 'emp', label: 'Employee' }], ['hours', 'number', { label: 'Hours worked' }]], crew, { emp: ref.employees }, readonly),
      materials: lineEditor([['item_id', 'ref', { ref: 'items', label: 'Item' }], ['qty', 'number', { label: 'Quantity used' }]], fresh ? [] : t.materials || [], { items: ref.items }, readonly),
    };
    sections.replaceChildren(h('div.lines', h('h3', 'Activities performed'), ed.lines.el), h('div.lines', h('h3', 'Crew on shift'), ed.crew.el), h('div.lines', h('h3', 'Materials consumed'), ed.materials.el));
  };
  f.project_id.onchange = () => build(true);
  build(false);

  const save = async status => {
    const body = { id: t.id, client_id: t.client_id, project_id: f.project_id.value, work_date: f.work_date.value, shift: f.shift.value, incidents: Number(f.incidents.value) || 0, remarks: f.remarks.value,
      lines: ed.lines.get(), crew: ed.crew.get(), materials: ed.materials.get(), status };
    if (!body.project_id || !body.work_date) throw new Error('Project and work date are required');
    if (status === 'submitted' && !body.lines.some(l => Number(l.hours) > 0)) throw new Error('Enter at least one activity with hours before submitting');
    try {
      if (onDevice) throw Object.assign(new Error('queued'), { offline: state.offline, requeue: true });
      const saved = await api('/operations/tickets', { body: { ...body, entry_mode: t.entry_mode || 'online' } });
      invalidate(); toast(`${saved.ticket_no} ${status === 'submitted' ? 'submitted' : 'saved as draft'}`, 'good');
    } catch (e) {
      if (!e.offline && !e.requeue) throw e;
      enqueue(body);                         // no connection: keep on device, sync later
      toast(state.offline ? 'Saved on this device. It will synchronise automatically when you are back online.' : 'Updated on this device - syncing…', 'good');
      if (!state.offline) import('../offline.js').then(m => m.flushQueue(true));
    }
    location.hash = base;
  };
  const approve = async () => { await api(`/operations/tickets/${t.id}/approve`, { body: {} }); invalidate(); toast('Ticket approved', 'good'); location.hash = base; };
  root.replaceChildren(...page([h('a', { href: base }, 'Daily Work Tickets'), h('span.sep', '/'), t.ticket_no || (onDevice ? 'On device' : 'New')], readonly ? null : [
    t.status !== 'submitted' ? actionBtn('Save draft', () => save('draft')) : null, actionBtn(t.status === 'submitted' ? 'Update' : 'Submit', () => save('submitted'), 'primary'),
    t.id && t.status === 'submitted' && SUPERVISORS.includes(state.user.role) ? actionBtn('Approve', approve) : null,
    onDevice ? h('button.btn.danger', { onclick: () => confirmBox('Discard this unsynced ticket from the device?', 'Discard', () => { dequeue(t.client_id); location.hash = base; }) }, 'Discard') : null],
  state.offline ? h('div.banner.warn', 'You are offline. This ticket will be stored on the device and synchronised automatically.') : null,
  h('section.card', h('header', h('div.statusbar', ['draft', 'submitted', 'approved'].map(s => h('span', { class: s === t.status ? 'on' : '' }, s))), t.entry_mode ? badge(`${t.entry_mode} entry`) : null),
    h('div.body', h('div.fields', field('Project *', f.project_id), field('Work date *', f.work_date), field('Shift', f.shift), field('HSE incidents', f.incidents), field('Remarks', f.remarks, 'wide')), sections))));
}
