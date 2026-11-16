// Project operations: real-time project overview and Daily Work Tickets (online + offline).
import { actionBtn, api, badge, can, card, confirmBox, field, fieldError, fmtDate, fmtDT, fmtMoney, fmtNum, h, invalidate, names, page, picker, rows, select, setActionBar, setDirty, simpleTable, state, stepper, toast, today,
  watchDirty } from '../core.js';
import { lineChart } from '../chart.js';
import { exceptionGroups, progress } from './dashboard.js';
import { dequeue, enqueue, flushQueue, loadRef, queued, saveRef } from '../offline.js';

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
  const days = o.trend.map(t => fmtDate(t.date).replace(/ \d{4}$/, ''));
  const over = a => Number(a.actual_hours) > Number(a.planned_hours) * 1.1;
  root.replaceChildren(...page([h('a', { href: base }, 'Projects'), h('span.sep', '/'), `${p.code} · ${p.name}`], [badge(p.status),
    can('operations') && p.status !== 'completed' ? h('a.btn.primary', { href: `#/operations/work_tickets/new?project=${id}` }, 'New work ticket') : null,
    can('operations') && p.status === 'active' ? h('button.btn', { onclick: complete }, 'Complete') : null],
  h('div.stack',
    h('div.kpis', tile('Progress vs plan', `${o.actual_pct}%`, `Planned to date ${o.planned_pct}% (${o.deviation > 0 ? '+' : ''}${o.deviation} pts)`, o.deviation < -5 ? 'bad' : o.deviation < 0 ? 'warn' : 'good'),
      tile('Accumulated cost', fmtMoney(o.cost), `Budget ${fmtMoney(o.budget)} · ${o.budget ? Math.round(o.cost / o.budget * 100) : 0}% used`, o.cost > o.budget ? 'bad' : ''),
      tile('Hours worked', `${fmtNum(o.hours)} h`, `${o.npt} h non-productive`, o.npt ? 'warn' : 'good'), tile('Work tickets', String(o.tickets), `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`),
      tile('Machine', (mach[p.machine_id] || 'None').split(' · ')[0], (mach[p.machine_id] || '').split(' · ')[1] || '')),
    card('Exceptions & deviations to date', o.exceptions.length ? badge(`${o.exceptions.length} open`, 'bad') : badge('On plan', 'good'), exceptionGroups(o.exceptions.map(e => ({ ...e, text: e.text + (e.item_id ? ` - ${item[e.item_id]}` : '') })))),
    o.trend.length > 1 ? h('div.widgets',
      card('Progress over time', h('span.muted', '% complete'), h('div.body', lineChart({ title: 'Planned versus actual progress by day', labels: days, max: 100, fmt: v => `${Math.round(v)}%`,
        series: [{ name: 'Planned', color: '--s1', values: o.trend.map(t => t.planned) }, { name: 'Actual', color: '--s2', values: o.trend.map(t => t.actual) }] }))),
      card('Cost over time', h('span.muted', state.currency), h('div.body', lineChart({ title: 'Planned spend versus actual cost by day', labels: days, fmt: v => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))),
        series: [{ name: 'Planned', color: '--s1', values: o.trend.map(t => t.planned_cost) }, { name: 'Actual', color: '--s2', values: o.trend.map(t => t.cost) }] })))) : null,
    card('Activities: planned vs actual', h('div.legend', h('span', h('i', { style: { background: 'var(--s1)' } }), 'Planned'), h('span', h('i', { style: { background: 'var(--s2)' } }), 'Actual progress')), h('div.body', h('div.gantt', o.activities.map(a => {
      const left = (new Date(a.planned_start) - t0) / span * 100, w = (new Date(a.planned_end) - new Date(a.planned_start)) / span * 100;
      return h('div.g-row', h('span', a.name), h('div.track', { title: `${fmtDT(a.planned_start)} → ${fmtDT(a.planned_end)} · ${Number(a.pct_complete) || 0}% complete` }, h('i', { style: { left: `${left}%`, width: `${w}%`, opacity: .5 } }),
        h('i.act', { style: { left: `${left}%`, width: `${w * (Number(a.pct_complete) || 0) / 100}%` } })),
      h('span.num.right', { class: over(a) ? '' : 'muted' }, over(a) ? h('span.badge.bad', `${fmtNum(a.actual_hours)}/${a.planned_hours} h`) : `${fmtNum(a.actual_hours)}/${a.planned_hours} h`));
    })))),
    h('div.widgets',
      card('KPIs', null, simpleTable([{ label: 'KPI', key: 'name' }, { label: 'Target', get: k => `${k.direction} ${k.target} ${k.unit || ''}` }, { label: 'Actual', get: k => (k.actual == null || k.actual === '' ? '–' : `${fmtNum(k.actual)} ${k.unit || ''}`), num: 1 },
        { label: 'Result', get: k => (k.ok == null ? badge('No data') : k.ok ? badge('On target', 'good') : badge('Off target', 'bad')) }], o.kpis, { empty: 'No KPIs defined' })),
      card('Accumulated cost by category', h('a.btn.small', { href: '#/operations/project_costs' }, 'All entries'), simpleTable([{ label: 'Category', get: r => r[0][0].toUpperCase() + r[0].slice(1) }, { label: `Amount (${state.currency})`, get: r => fmtNum(r[1]), num: 1 }],
        [...Object.entries(o.cost_by_category), ['Total', o.cost], ['Budget', o.budget]])),
      card('Field manning', null, simpleTable([{ label: 'Position', key: 'position' }, { label: 'Employee', get: m => emp[m.employee_id] || badge('Shortage', 'bad') }], o.manning)),
      card('Materials: required vs issued', null, simpleTable([{ label: 'Item', get: m => item[m.item_id] }, { label: 'Required', get: m => fmtNum(m.qty_required), num: 1 }, { label: 'Issued', get: m => fmtNum(m.qty_issued), num: 1 }], o.materials)))),
  h('div', { style: { marginTop: '10px' } }, progress(o.planned_pct, o.actual_pct))));
}

// ---------- Daily Work Tickets ----------
const SUPERVISORS = ['rig_supervisor', 'rig_manager', 'operations_head', 'admin'];
const DRAFT = 'wo_dwt_draft:';
const readDraft = k => { try { return JSON.parse(localStorage.getItem(DRAFT + k)); } catch { return null; } };
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
  const q = queued(), draft = readDraft('new');
  const newBtn = () => (can('operations') ? h('a.btn.primary', { href: `${base}/new` }, draft ? 'Continue draft' : 'New ticket') : null);
  root.replaceChildren(...page('Daily Work Tickets', newBtn(),
    state.offline ? h('div.banner.warn', 'Offline mode: tickets are saved on this device and synchronise automatically when the connection returns.') : null,
    draft ? h('div.banner', `You have an unfinished ticket for ${P[draft.project_id] || 'a project'}, ${fmtDate(draft.work_date)}, saved on this device.`) : null,
    q.length ? card(`Waiting to sync (${q.length})`, state.offline ? null : actionBtn('Sync now', () => flushQueue(true), 'small'), simpleTable([{ label: 'Project', get: t => P[t.project_id] }, { label: 'Date', get: t => fmtDate(t.work_date) }, { label: 'Shift', key: 'shift' }, { label: 'Saved', get: t => fmtDT(t.queued_at) }, { label: 'Status', get: () => badge('On device', 'warn') }],
      q, { onRow: t => { location.hash = `${base}/q-${t.client_id}`; } })) : null, q.length ? h('div', { style: { height: '12px' } }) : null,
    card(null, null, simpleTable([{ label: 'Ticket', key: 'ticket_no' }, { label: 'Project', get: t => P[t.project_id] || '' }, { label: 'Date', get: t => fmtDate(t.work_date) }, { label: 'Shift', key: 'shift' },
      { label: 'Hours', get: t => fmtNum((t.lines || []).reduce((a, l) => a + (Number(l.hours) || 0), 0)), num: 1 }, { label: 'Crew', get: t => (t.crew || []).length, num: 1 }, { label: 'Entry', get: t => badge(t.entry_mode) }, { label: 'Status', get: t => badge(t.status) }],
    tickets, { onRow: t => { location.hash = `${base}/${t.id}`; }, empty: state.offline ? 'Submitted tickets are shown when you are back online.' : 'No work tickets yet. Tap "New ticket" to record today\'s work.' }))));
  setActionBar([newBtn()]);
}

const numInput = (value, on, attrs = {}) => h('input', { type: 'number', inputMode: 'decimal', step: 'any', min: 0, value: value ?? '', oninput: e => on(e.target.value), ...attrs });

async function ticketForm(root, rawId, base) {
  const [id, query] = rawId.split('?');
  const ref = await reference();
  const key = id === 'new' ? 'new' : id.replace(/^q-/, '');
  const saved = readDraft(key);
  let t, restored = false;
  if (id === 'new') t = { client_id: crypto.randomUUID(), project_id: new URLSearchParams(query).get('project') || ref.projects[0]?.id, work_date: today(), shift: 'day', status: 'draft', incidents: 0 };
  else if (id.startsWith('q-')) t = queued().find(x => x.client_id === id.slice(2));
  else t = await api(`/data/work_tickets/${id}`);
  if (!t) throw new Error('Ticket not found');
  const onDevice = id.startsWith('q-'), readonly = t.status === 'approved' || !can('operations');
  if (saved && !readonly) { t = { ...t, ...saved }; restored = true; }
  const fresh = id === 'new' && !restored;
  t.lines = (t.lines?.length ? t.lines : [{}]).map(l => ({ ...l }));
  t.crew = (fresh || !t.crew ? ref.manning.filter(m => m.project_id === t.project_id).map(m => ({ employee_id: m.employee_id, hours: 12 })) : t.crew).map(c => ({ ...c }));
  t.materials = (t.materials || []).map(m => ({ ...m }));

  // Every change is kept on the device, so a dropped signal, a wrong tap or a closed tab loses nothing.
  let timer;
  const status = h('span.muted', { role: 'status', style: { fontSize: '12.5px' } }, restored ? 'Restored unsaved changes from this device' : '');
  const body = st => ({ id: t.id, client_id: t.client_id, project_id: f.project_id.value, work_date: f.work_date.value, shift: f.shift.value, incidents: Number(f.incidents.value) || 0, remarks: f.remarks.value,
    lines: t.lines.filter(l => l.activity_id || l.description || Number(l.hours) > 0), crew: t.crew.filter(c => c.employee_id), materials: t.materials.filter(m => m.item_id && Number(m.qty) > 0), status: st });
  const autosave = () => { if (readonly) return; clearTimeout(timer); timer = setTimeout(() => { localStorage.setItem(DRAFT + key, JSON.stringify(body(t.status))); status.textContent = `Changes kept on this device at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; }, 500); };
  const clearDraft = () => { clearTimeout(timer); localStorage.removeItem(DRAFT + key); };

  const f = { project_id: select(ref.projects.map(p => [p.id, `${p.code} · ${p.name}`]), t.project_id, { disabled: readonly || !!t.id }), work_date: h('input', { type: 'date', value: t.work_date, disabled: readonly }),
    shift: select(['day', 'night'], t.shift, { disabled: readonly }), incidents: h('input', { type: 'number', inputMode: 'numeric', min: 0, value: t.incidents ?? 0, disabled: readonly }), remarks: h('textarea', { value: t.remarks || '', disabled: readonly }) };

  // --- Activities
  const actBox = h('div'), actBadge = h('span.badge'), actErr = h('div.banner.bad', { hidden: true, role: 'alert' });
  const drawActs = () => {
    const acts = ref.activities.filter(a => a.project_id === f.project_id.value).sort((a, b) => a.seq - b.seq).map(a => [a.id, a.name]);
    const hours = t.lines.reduce((a, l) => a + (Number(l.hours) || 0), 0);
    actBadge.textContent = `${t.lines.length} · ${fmtNum(hours)} h`;
    actBox.replaceChildren(...t.lines.map((l, i) => h('div.entry',
      field('Activity', select([['', 'Select activity…'], ...acts], l.activity_id, { disabled: readonly, onchange: e => { l.activity_id = e.target.value; autosave(); } }), 'wide'),
      field('Hours', stepper(numInput(l.hours, v => { l.hours = v; drawHead(); autosave(); }, { disabled: readonly }), 1)),
      field('% complete', stepper(numInput(l.pct_complete, v => { l.pct_complete = v; autosave(); }, { disabled: readonly, max: 100 }), 5)),
      field('What was done', h('input', { value: l.description || '', disabled: readonly, oninput: e => { l.description = e.target.value; autosave(); } }), 'wide'),
      field('Depth from (ft)', numInput(l.depth_from, v => { l.depth_from = v; autosave(); }, { disabled: readonly })),
      field('Depth to (ft)', numInput(l.depth_to, v => { l.depth_to = v; autosave(); }, { disabled: readonly })),
      h('div.field.check', h('label', { htmlFor: `npt${i}` }, 'Non-productive time (NPT)'), h('input', { id: `npt${i}`, type: 'checkbox', checked: !!l.npt, disabled: readonly, onchange: e => { l.npt = e.target.checked; autosave(); } })),
      readonly || t.lines.length < 2 ? null : h('button.btn.danger', { type: 'button', onclick: () => { t.lines.splice(i, 1); drawActs(); autosave(); } }, 'Remove activity'))),
    readonly ? '' : h('button.btn', { type: 'button', onclick: () => { t.lines.push({}); drawActs(); autosave(); } }, '+ Add activity'));
  };
  const drawHead = () => { actBadge.textContent = `${t.lines.length} · ${fmtNum(t.lines.reduce((a, l) => a + (Number(l.hours) || 0), 0))} h`; };

  // --- Crew
  const crewBox = h('div'), crewBadge = h('span.badge');
  const drawCrew = () => {
    crewBadge.textContent = `${t.crew.length} people · ${fmtNum(t.crew.reduce((a, c) => a + (Number(c.hours) || 0), 0))} h`;
    const all = numInput(12, () => {}, { 'aria-label': 'Hours for all crew' });
    const free = Object.entries(ref.employees).filter(([eid]) => !t.crew.some(c => c.employee_id === eid));
    const add = picker(free, '', { 'aria-label': 'Add crew member', onchange: e => { if (e.target.value) { t.crew.push({ employee_id: e.target.value, hours: Number(all.value) || 12 }); drawCrew(); autosave(); } } });
    crewBox.replaceChildren(
      readonly || !t.crew.length ? '' : h('div.entry', field('Set the same hours for everyone', stepper(all, 1)), h('button.btn', { type: 'button', onclick: () => { t.crew.forEach(c => { c.hours = Number(all.value) || 0; }); drawCrew(); autosave(); } }, 'Apply to all')),
      ...t.crew.map((c, i) => h('div.crew-row', h('div', h('strong', (ref.employees[c.employee_id] || 'Unknown').replace(/ \(.*/, '')), h('div.muted', { style: { fontSize: '12px' } }, /\((.*)\)/.exec(ref.employees[c.employee_id] || '')?.[1] || '')),
        h('div.row', { style: { flexWrap: 'nowrap' } }, stepper(numInput(c.hours, v => { c.hours = v; autosave(); }, { disabled: readonly, 'aria-label': `Hours for ${ref.employees[c.employee_id]}`, style: { width: '70px' } }), 1),
          readonly ? null : h('button.btn.danger', { type: 'button', 'aria-label': `Remove ${ref.employees[c.employee_id]}`, onclick: () => { t.crew.splice(i, 1); drawCrew(); autosave(); } }, '✕')))),
      readonly ? '' : h('div', { style: { marginTop: '10px' } }, field('Add crew member', add)));
  };

  // --- Materials
  const matBox = h('div'), matBadge = h('span.badge');
  const drawMats = () => {
    matBadge.textContent = `${t.materials.filter(m => m.item_id).length} items`;
    matBox.replaceChildren(...t.materials.map((mt, i) => h('div.entry',
      field('Item', picker(Object.entries(ref.items), mt.item_id, { disabled: readonly, onchange: e => { mt.item_id = e.target.value; drawMats(); autosave(); } }), 'wide'),
      field('Quantity used', numInput(mt.qty, v => { mt.qty = v; autosave(); }, { disabled: readonly })),
      readonly ? null : h('button.btn.danger', { type: 'button', onclick: () => { t.materials.splice(i, 1); drawMats(); autosave(); } }, 'Remove'))),
    readonly ? (t.materials.length ? '' : h('p.muted', 'No materials recorded.')) : h('button.btn', { type: 'button', onclick: () => { t.materials.push({}); drawMats(); autosave(); } }, '+ Add material'));
  };
  f.project_id.onchange = () => { t.lines = [{}]; t.crew = ref.manning.filter(m => m.project_id === f.project_id.value).map(m => ({ employee_id: m.employee_id, hours: 12 })); drawActs(); drawCrew(); autosave(); };
  const section = (title, badgeEl, content, open) => h('details.sec', { open }, h('summary', title, badgeEl), h('div.in', content));
  const actSec = section('Activities performed', actBadge, [actErr, actBox], true);
  drawActs(); drawCrew(); drawMats();

  const save = async st => {
    actErr.hidden = true; fieldError(f.project_id, ''); fieldError(f.work_date, '');
    const b = body(st);
    if (!b.project_id) { fieldError(f.project_id, 'Choose the project'); f.project_id.focus(); return; }
    if (!b.work_date) { fieldError(f.work_date, 'Enter the work date'); f.work_date.focus(); return; }
    if (st === 'submitted' && !b.lines.some(l => l.activity_id && Number(l.hours) > 0)) {
      actErr.textContent = 'Add at least one activity with hours before submitting.'; actErr.hidden = false; actSec.open = true; actSec.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    try {
      if (onDevice) throw Object.assign(new Error('queued'), { requeue: true });
      const res = await api('/operations/tickets', { body: { ...b, entry_mode: t.entry_mode || 'online' } });
      invalidate(); toast(`${res.ticket_no} ${st === 'submitted' ? 'submitted' : 'saved as draft'}`, 'good');
    } catch (e) {
      if (!e.offline && !e.requeue) throw e;
      enqueue(b);                         // no connection: keep on device, sync later
      toast(state.offline ? 'Saved on this device. It will synchronise automatically when you are back online.' : 'Updated on this device - syncing…', 'good');
      if (!state.offline) flushQueue(true);
    }
    clearDraft(); setDirty(false); location.hash = base;
  };
  const approve = () => confirmBox(`Approve ${t.ticket_no}? Approved tickets can no longer be changed.`, 'Approve ticket', async () => { await api(`/operations/tickets/${t.id}/approve`, { body: {} }); invalidate(); toast('Ticket approved', 'good'); location.hash = base; });
  const discard = () => confirmBox(onDevice ? 'Discard this unsynced ticket from the device?' : 'Discard the unsaved changes kept on this device?', 'Discard', () => { clearDraft(); if (onDevice) dequeue(t.client_id); setDirty(false); location.hash = base; }, { danger: true });
  const buttons = bar => (readonly ? [] : [
    t.status !== 'submitted' ? actionBtn('Save draft', () => save('draft'), 'in-bar') : null, actionBtn(t.status === 'submitted' ? 'Update' : 'Submit', () => save('submitted'), 'primary in-bar'),
    !bar && t.id && t.status === 'submitted' && SUPERVISORS.includes(state.user.role) ? h('button.btn', { type: 'button', onclick: approve }, 'Approve') : null,
    !bar && (onDevice || restored) ? h('button.btn.danger', { type: 'button', onclick: discard }, 'Discard') : null]);
  const sheet = h('div',
    h('section.card', h('header', h('div.statusbar', ['draft', 'submitted', 'approved'].map(s => h('span', { class: s === t.status ? 'on' : '' }, s))), t.entry_mode ? badge(`${t.entry_mode} entry`) : null, status),
      h('div.body', h('div.fields', field('Project *', f.project_id), field('Work date *', f.work_date), field('Shift', f.shift), field('HSE incidents', stepper(f.incidents, 1)), field('Remarks', f.remarks, 'wide')))),
    actSec, section('Crew on shift', crewBadge, crewBox, false), section('Materials consumed', matBadge, matBox, false));
  sheet.addEventListener('input', autosave); sheet.addEventListener('change', autosave);
  root.replaceChildren(...page([h('a', { href: base }, 'Daily Work Tickets'), h('span.sep', '/'), t.ticket_no || (onDevice ? 'On device' : 'New')], buttons(false),
    state.offline ? h('div.banner.warn', 'You are offline. This ticket will be stored on the device and synchronised automatically.') : null, sheet));
  setDirty(false);
  if (!readonly) { setActionBar(buttons(true)); if (t.id) watchDirty(sheet); }
}
