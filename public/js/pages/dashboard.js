// Role-adaptive dashboard: the server decides which widgets a role gets; this renders them.
import { api, card, fmtMoney, h, page, reasonBox, simpleTable, state, toast } from '../core.js';
import { sparkline } from '../chart.js';

const pct = v => Math.max(0, Math.min(100, Number(v) || 0));
export const progress = (planned, actual) => h('div.pv', { role: 'img', 'aria-label': `Planned ${planned}%, actual ${actual}%` },
  h('span', 'Planned'), h('div.bar.plan', h('i', { style: { width: `${pct(planned)}%` } })), h('span.num', `${planned}%`),
  h('span', 'Actual'), h('div.bar', h('i', { style: { width: `${pct(actual)}%` } })), h('span.num', `${actual}%`));

// Exceptions grouped by type, worst first; a group with several items expands to show them all.
const RANK = { high: 0, medium: 1, low: 2 }, WORD = { high: 'High', medium: 'Medium', low: 'Low' };
export function exceptionGroups(list, link) {
  if (!list.length) return h('div.empty', 'No exceptions - everything is on plan');
  const groups = Object.entries(list.reduce((a, e) => ((a[e.type] ||= []).push(e), a), {}))
    .map(([type, items]) => ({ type, items: items.sort((a, b) => RANK[a.level] - RANK[b.level]), worst: items.reduce((w, e) => Math.min(w, RANK[e.level]), 2) })).sort((a, b) => a.worst - b.worst || b.items.length - a.items.length);
  const line = e => [e.project ? h('strong', `${e.project}: `) : null, e.text];
  return h('div', groups.map(g => {
    const level = Object.keys(RANK)[g.worst];
    const head = [h('span.dot', { class: level }), h('span.sr', `${WORD[level]} severity`), h('span.badge', g.type)];
    if (g.items.length === 1) return h('div.item', head, h('span.grow', line(g.items[0])), link?.(g.items[0]));
    return h('details.exg', h('summary.item', head, h('span.grow', line(g.items[0])), h('span.badge', { class: g.worst === 0 ? 'bad' : 'warn' }, `${g.items.length} issues ▾`)),
      h('ul', g.items.map(e => h('li', line(e), ' ', link?.(e)))));
  }));
}

export async function dashboardPage(root, canOpen) {
  const d = await api('/dashboard');
  const reload = () => dashboardPage(root, canOpen);
  const link = (l, el) => { if (canOpen(l)) el.href = `#/${l}`; return el; };
  const decide = (a, approve) => reasonBox({ title: `${approve ? 'Approve' : 'Reject'}: ${a.title}`, text: a.text, label: approve ? 'Approve' : 'Reject', required: !approve, danger: !approve }, async note => {
    await api(a.kind === 'po' ? `/procurement/po/${a.id}/decide` : `/operations/alerts/${a.id}/decide`, { body: { approve, note } });
    toast(approve ? 'Approved' : 'Rejected', 'good'); reload();
  });
  const render = {
    list: w => card(w.title, canOpen(w.link) ? h('a.btn.small', { href: `#/${w.link}` }, 'Open') : null,
      simpleTable(w.columns.map((c, i) => ({ label: c, get: r => r[i], num: typeof w.rows[0]?.[i] === 'number' })), w.rows)),
    projects: w => card(w.title, h('span.badge.good', 'Live'), w.rows.length ? w.rows.map(p => h(canOpen('operations') ? 'a.proj' : 'div.proj', { href: canOpen('operations') ? `#/operations/projects/${p.id}` : null },
      h('div', h('strong', p.code), ' ', h('span.badge', { class: p.status === 'active' ? 'good' : 'warn' }, p.status[0].toUpperCase() + p.status.slice(1)), h('div.muted', p.name)),
      progress(p.planned, p.actual), sparkline(p.trend),
      h('div', h('div', h('span.badge', { class: p.deviation < -5 ? 'bad' : p.deviation < 0 ? 'warn' : 'good' }, `${p.deviation > 0 ? '+' : ''}${p.deviation} pts vs plan`), ' ',
        p.exceptions ? h('span.badge.bad', `${p.exceptions} exception${p.exceptions > 1 ? 's' : ''}`) : null),
      h('div.muted.num', { style: { marginTop: '4px' } }, `Cost ${fmtMoney(p.cost)} of ${fmtMoney(p.budget)}`)))) : h('div.empty', 'No planned or active projects')),
    exceptions: w => card(w.title, w.rows.length ? h('span.badge.bad', `${w.rows.length} open`) : null,
      exceptionGroups(w.rows, e => (canOpen('operations') ? h('a', { href: `#/operations/projects/${e.id}`, 'aria-label': `Open project ${e.project}` }, 'Open') : null))),
    approvals: w => card(w.title, w.items.length ? h('span.pill', String(w.items.length)) : null, w.items.length ? w.items.map(a =>
      h('div.item', h('span.badge.warn', a.kind === 'po' ? 'Purchase order' : 'Work-day limit'), h('div.grow', h('strong', a.title), h('div.muted', a.text)),
        h('div.row', h('button.btn.primary.small', { onclick: () => decide(a, true) }, 'Approve'), h('button.btn.danger.small', { onclick: () => decide(a, false) }, 'Reject')))) : h('div.empty', 'Nothing is waiting for you')),
  };
  const kpis = d.widgets.filter(w => w.type === 'kpi'), rest = d.widgets.filter(w => w.type !== 'kpi');
  root.replaceChildren(...page(`${d.role} dashboard`, [h('span.muted', `${state.company} · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`), h('button.btn', { onclick: reload }, 'Refresh')],
    h('div.stack',
      h('div.kpis', kpis.map(k => link(k.link, h(canOpen(k.link) ? 'a.card.kpi' : 'div.card.kpi', { class: k.tone }, h('div.t', k.title), h('div.v', String(k.value)), k.sub ? h('div.s', k.sub) : null)))),
      h('div.widgets', rest.map(w => { const el = (render[w.type] || (() => null))(w); if (el && w.wide) el.classList.add('wide'); return el; })))));
}
