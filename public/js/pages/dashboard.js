// Role-adaptive dashboard: the server decides which widgets a role gets; this renders them.
import { actionBtn, api, card, fmtNum, h, page, simpleTable, state, toast } from '../core.js';

const pct = v => Math.max(0, Math.min(100, Number(v) || 0));
export const progress = (planned, actual) => h('div.pv',
  h('span', 'Planned'), h('div.bar.plan', h('i', { style: { width: `${pct(planned)}%` } })), h('span.num', `${planned}%`),
  h('span', 'Actual'), h('div.bar', { class: actual < planned - 5 ? 'bad' : 'good' }, h('i', { style: { width: `${pct(actual)}%` } })), h('span.num', `${actual}%`));

export async function dashboardPage(root, canOpen) {
  const d = await api('/dashboard');
  const reload = () => dashboardPage(root, canOpen);
  const link = (l, el) => { if (canOpen(l)) el.href = `#/${l}`; return el; };
  const render = {
    list: w => card(w.title, canOpen(w.link) ? h('a.btn.small', { href: `#/${w.link}` }, 'Open') : null,
      simpleTable(w.columns.map((c, i) => ({ label: c, get: r => r[i], num: typeof w.rows[0]?.[i] === 'number' })), w.rows)),
    projects: w => card(w.title, h('span.badge.good', 'Live'), w.rows.length ? w.rows.map(p => h(canOpen('operations') ? 'a.proj' : 'div.proj', { href: canOpen('operations') ? `#/operations/projects/${p.id}` : null },
      h('div', h('strong', p.code), ' ', h('span.badge', { class: p.status === 'active' ? 'good' : 'warn' }, p.status), h('div.muted', p.name)),
      progress(p.planned, p.actual),
      h('div', h('div', h('span.badge', { class: p.deviation < -5 ? 'bad' : p.deviation < 0 ? 'warn' : 'good' }, `${p.deviation > 0 ? '+' : ''}${p.deviation} pts vs plan`), ' ',
        p.exceptions ? h('span.badge.bad', `${p.exceptions} exception${p.exceptions > 1 ? 's' : ''}`) : null),
      h('div.muted.num', { style: { marginTop: '4px' } }, `Cost ${fmtNum(p.cost, 0)} of ${fmtNum(p.budget, 0)}`)))) : h('div.empty', 'No planned or active projects')),
    exceptions: w => card(w.title, null, w.rows.length ? w.rows.map(e => h('div.item', h('span.dot', { class: e.level, title: e.level }), h('span.badge', e.type), h('span.grow', e.text),
      canOpen('operations') ? h('a.muted', { href: `#/operations/projects/${e.id}` }, e.project) : h('span.muted', e.project))) : h('div.empty', 'No exceptions - everything is on plan')),
    approvals: w => card(w.title, w.items.length ? h('span.pill', String(w.items.length)) : null, w.items.length ? w.items.map(a => {
      const decide = approve => actionBtn(approve ? 'Approve' : 'Reject', async () => {
        await api(a.kind === 'po' ? `/procurement/po/${a.id}/decide` : `/operations/alerts/${a.id}/decide`, { body: { approve } });
        toast(approve ? 'Approved' : 'Rejected', 'good'); reload();
      }, approve ? 'primary small' : 'danger small');
      return h('div.item', h('span.badge.warn', a.kind === 'po' ? 'Purchase order' : 'Work-day limit'), h('div.grow', h('strong', a.title), h('div.muted', a.text)), h('div.row', decide(true), decide(false)));
    }) : h('div.empty', 'Nothing is waiting for you')),
  };
  const kpis = d.widgets.filter(w => w.type === 'kpi'), rest = d.widgets.filter(w => w.type !== 'kpi');
  root.replaceChildren(...page(`${d.role} dashboard`, [h('span.muted', state.company), h('button.btn', { onclick: reload }, 'Refresh')],
    h('div.stack',
      h('div.kpis', kpis.map(k => link(k.link, h(canOpen(k.link) ? 'a.card.kpi' : 'div.card.kpi', { class: k.tone }, h('div.t', k.title), h('div.v', String(k.value)), k.sub ? h('div.s', k.sub) : null)))),
      h('div.widgets', rest.map(w => { const el = (render[w.type] || (() => null))(w); if (el && w.wide) el.classList.add('wide'); return el; })))));
}
