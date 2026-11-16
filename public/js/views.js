// Generic list and form views generated from the model metadata (server/models.js).
import { actionBtn, api, badge, can, cap, card, confirmBox, fieldError, fieldLabel, fmtDate, fmtField, fmtNum, h, invalidate, model, names, oops, page, picker, reasonBox, roleLabel, rowAttrs, rows, select,
  setActionBar, setDirty, state, toast, watchDirty } from './core.js';

const visible = m => Object.entries(m.fields).filter(([, f]) => !f.hidden);
async function lookupsFor(m, keys) {
  const out = {};
  await Promise.all([...new Set(keys.map(k => m.fields[k]?.ref).filter(Boolean))].map(async t => { out[t] = await names(t); }));
  return out;
}
const plain = v => (v instanceof Node ? v.textContent : String(v ?? ''));

// A readable title for any record: "Jorge Reyes · Vacation · 4 Dec 2026" instead of a bare type or date.
function recordTitle(m, rec, lookups) {
  const f = m.fields[m.display], main = plain(fmtField(f, rec[m.display], lookups));
  const who = m.display !== 'name' && m.fields.employee_id && lookups.employees?.[rec.employee_id];
  const when = f.type !== 'date' && (rec.start_date || rec.work_date);
  return [who, main, when && who ? fmtDate(when) : null].filter(Boolean).join(' · ') || m.label;
}

const PAGE = 50;
export async function listView(root, cfg, base) {
  const m = model(cfg.table);
  const cols = cfg.cols || visible(m).filter(([, f]) => !['json', 'longtext'].includes(f.type)).map(([k]) => k).slice(0, 7);
  let data = await rows(cfg.table);
  if (cfg.mine) data = data.filter(r => r.employee_id === state.user.employee_id);
  if (cfg.filter) data = data.filter(cfg.filter);
  if (cfg.sort) data = [...data].sort(cfg.sort); else if (m.fields.status || cfg.newest) data = [...data].reverse();
  const lookups = await lookupsFor(m, cols);
  const writable = can(...m.modules) && cfg.create !== false && !cfg.readonly;
  const statuses = (m.fields.status?.options || []).filter(s => data.some(r => r.status === s));
  let q = '', chip = '', sortKey = null, dir = 1, pageNo = 0;
  const body = h('div');
  const text = r => cols.map(k => plain(fmtField(m.fields[k], r[k], lookups))).join(' ').toLowerCase();
  const sortVal = (r, k) => { const f = m.fields[k], v = r[k]; return f.type === 'number' ? Number(v) || 0 : f.type === 'ref' ? (lookups[f.ref]?.[v] || '').toLowerCase() : String(v ?? '').toLowerCase(); };
  const current = () => {
    let shown = data.filter(r => (!chip || r.status === chip) && (!q || text(r).includes(q)));
    if (sortKey) shown = [...shown].sort((a, b) => { const x = sortVal(a, sortKey), y = sortVal(b, sortKey); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    return shown;
  };
  const head = k => { const f = m.fields[k], on = sortKey === k;
    return h('th', { class: f.type === 'number' ? 'num' : '', scope: 'col', 'aria-sort': on ? (dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', title: 'Sort', onclick: () => { dir = on ? -dir : 1; sortKey = k; pageNo = 0; draw(); } }, fieldLabel(f), on ? (dir > 0 ? ' ▲' : ' ▼') : '')); };
  const draw = () => {
    const shown = current(), pages = Math.max(1, Math.ceil(shown.length / PAGE));
    pageNo = Math.min(pageNo, pages - 1);
    const slice = shown.slice(pageNo * PAGE, pageNo * PAGE + PAGE);
    body.replaceChildren(!shown.length ? h('div.empty', data.length ? 'No records match your search or filter.' : `No ${m.label.toLowerCase()} yet.`,
      !data.length && writable ? h('a.btn.primary', { href: `${base}/new` }, `Create the first one`) : data.length ? h('button.btn', { onclick: () => { q = ''; chip = ''; search.value = ''; drawChips(); draw(); } }, 'Clear filters') : null) :
      h('div.table-wrap', h('table.cards.compact', h('thead', h('tr', cols.map(head))),
        h('tbody', slice.map(r => h('tr', rowAttrs(() => { location.hash = `${base}/${r.id}`; }),
          cols.map((k, i) => h('td', { class: [m.fields[k].type === 'number' ? 'num' : '', i > 3 && k !== 'status' ? 'c-hide' : ''].join(' ').trim(), 'data-label': m.fields[k].label }, fmtField(m.fields[k], r[k], lookups)))))))),
      shown.length > PAGE ? h('div.pager', `${pageNo * PAGE + 1}–${pageNo * PAGE + slice.length} of ${shown.length}`,
        h('button.btn.small', { disabled: !pageNo, onclick: () => { pageNo--; draw(); } }, 'Previous'), h('button.btn.small', { disabled: pageNo >= pages - 1, onclick: () => { pageNo++; draw(); } }, 'Next')) : null);
  };
  const chipBox = h('div.chips', { role: 'group', 'aria-label': 'Filter by status' });
  const drawChips = () => chipBox.replaceChildren(...['', ...statuses].map(s => h('button.chip', { type: 'button', class: s === chip ? 'on' : '', 'aria-pressed': String(s === chip),
    onclick: () => { chip = s; pageNo = 0; drawChips(); draw(); } }, `${s ? cap(s) : 'All'} (${s ? data.filter(r => r.status === s).length : data.length})`)));
  const search = h('input.search', { type: 'search', placeholder: 'Search…', 'aria-label': `Search ${m.label}`, oninput: e => { q = e.target.value.toLowerCase(); pageNo = 0; draw(); } });
  const exportCsv = async () => {
    const fields = visible(m).filter(([, f]) => f.type !== 'json'), lk = await lookupsFor(m, fields.map(([k]) => k));
    const esc = v => `"${plain(v).replace(/"/g, '""')}"`;
    const csv = [fields.map(([, f]) => esc(fieldLabel(f))).join(','), ...current().map(r => fields.map(([k, f]) => esc(f.type === 'number' ? r[k] ?? '' : f.type === 'ref' ? lk[f.ref]?.[r[k]] || '' : r[k] ?? '')).join(','))].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv' })), download: `${cfg.table}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  root.replaceChildren(...page(cfg.title || m.label, [search,
    (cfg.toolbar || []).filter(t => !t.show || t.show()).map(t => actionBtn(t.label, async () => { const msg = await t.run(); invalidate(); if (msg) toast(msg, 'good'); await listView(root, cfg, base); })),
    data.length ? actionBtn('Export', exportCsv) : null,
    writable ? h('a.btn.primary', { href: `${base}/new` }, 'New') : null,
  ], cfg.intro ? h('div.banner', cfg.intro) : null, statuses.length > 1 ? h('div', { style: { marginBottom: '10px' } }, chipBox) : null, card(null, null, body)));
  drawChips(); draw();
}

// Editable sub-table for JSON line fields (PO lines, RFQ lines…)
export function lineEditor(cols, lines, lookups, disabled) {
  const data = (lines || []).map(l => ({ ...l }));
  const tbody = h('tbody'), total = h('td.num');
  const hasTotal = cols.some(c => c[0] === 'qty') && cols.some(c => c[0] === 'price');
  const sum = () => { if (hasTotal) total.textContent = fmtNum(data.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0)); };
  const label = c => c[2]?.label || c[0].replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
  const input = (l, c) => {
    const [name, type = 'text', o = {}] = c, aria = label(c);
    const set = e => { l[name] = type === 'bool' ? e.target.checked : e.target.value; sum(); };
    if (type === 'ref') return picker(Object.entries(lookups[o.ref] || {}), l[name], { onchange: set, disabled, 'aria-label': aria });
    if (type === 'select') return select(['', ...o.options], l[name], { onchange: set, disabled, 'aria-label': aria });
    if (type === 'bool') return h('input', { type: 'checkbox', checked: !!l[name], onchange: set, disabled, 'aria-label': aria });
    return h('input', { type: type === 'number' ? 'number' : 'text', step: 'any', inputMode: type === 'number' ? 'decimal' : null, value: l[name] ?? '', oninput: set, disabled, 'aria-label': aria });
  };
  const changed = () => el.dispatchEvent(new Event('change', { bubbles: true }));
  const draw = () => { tbody.replaceChildren(...data.map((l, i) => h('tr', cols.map(c => h('td', { 'data-label': label(c) }, input(l, c))),
    h('td', disabled ? null : h('button.btn.small.danger', { type: 'button', 'aria-label': `Remove line ${i + 1}`, onclick: () => { data.splice(i, 1); draw(); changed(); } }, '✕'))))); sum(); };
  const el = h('div', h('div.table-wrap', h('table.cards', h('thead', h('tr', cols.map(c => h('th', { scope: 'col' }, label(c))), h('th', h('span.sr', 'Remove')))), tbody,
    hasTotal ? h('tfoot', h('tr', h('td', { colSpan: cols.length - 1 }, 'Total'), total, h('td'))) : null)),
    disabled ? null : h('button.btn.small', { type: 'button', style: { marginTop: '8px' }, onclick: () => { data.push({}); draw(); changed(); } }, '+ Add line'));
  draw();
  return { el, get: () => data.filter(l => Object.values(l).some(v => v !== '' && v != null)) };
}

export async function formView(root, cfg, id, base) {
  const m = model(cfg.table), isNew = id === 'new';
  const rec = isNew ? { ...(cfg.defaults?.() || {}) } : await api(`/data/${cfg.table}/${id}`);
  const fields = visible(m).filter(([, f]) => f.type !== 'json' || f.cols);
  const lineCols = fields.filter(([, f]) => f.type === 'json').flatMap(([, f]) => f.cols.map(c => c[2]?.ref).filter(Boolean));
  const lookups = await lookupsFor(m, fields.map(([k]) => k));
  await Promise.all([...new Set(lineCols)].map(async t => { lookups[t] = await names(t); }));
  const locked = cfg.locked?.(rec) || false;
  const writable = can(...m.modules) && !cfg.readonly && !locked;
  const get = {}, els = {};
  const isRole = (k, f) => f.type === 'select' && f.options.every(o => state.meta.roles[o]);
  const controls = Object.fromEntries(fields.filter(([, f]) => f.type !== 'json').map(([k, f]) => {
    const dis = !writable || !!f.ro || (cfg.mine && k === 'employee_id') || (cfg.lockFields || []).includes(k);
    let el;
    if (f.type === 'ref') el = picker(Object.entries(lookups[f.ref] || {}).sort((a, b) => a[1].localeCompare(b[1])), rec[k], { disabled: dis });
    else if (isRole(k, f)) el = select([['', ''], ...f.options.map(o => [o, roleLabel(o)])], rec[k], { disabled: dis });
    else if (f.type === 'select') el = select(f.options.includes('') ? f.options : ['', ...f.options], rec[k], { disabled: dis });
    else if (f.type === 'bool') el = h('input', { type: 'checkbox', checked: !!rec[k], disabled: dis });
    else if (f.type === 'longtext') el = h('textarea', { value: rec[k] ?? '', disabled: dis });
    else el = h('input', { type: { number: 'number', date: 'date' }[f.type] || 'text', step: 'any', inputMode: f.type === 'number' ? 'decimal' : null, disabled: dis,
      value: f.type === 'datetime' ? fmtField(f, rec[k]) : /role|approver/i.test(f.label) && state.meta.roles[rec[k]] ? roleLabel(rec[k]) : rec[k] ?? '', placeholder: f.auto && isNew ? 'Assigned automatically' : '' });
    if (!dis && f.type !== 'datetime') get[k] = () => (f.type === 'bool' ? el.checked : el.value);
    const target = el.matches('input, select, textarea') ? el : el.querySelector('input');
    target.id = `f_${k}`; els[k] = target;
    if (f.req) target.setAttribute('aria-required', 'true');
    target.addEventListener('input', () => fieldError(target, ''));
    return [k, h('div.field', { class: f.type === 'bool' ? 'check' : f.type === 'longtext' ? 'wide' : '' }, h('label', { htmlFor: target.id }, fieldLabel(f) + (f.req ? ' *' : '')), el)];
  }));
  // Long records are split into titled sections (models.js); everything else sits under the first block.
  const inSection = new Set(Object.values(m.sections || {}).flat());
  const blocks = [h('div.fields', Object.entries(controls).filter(([k]) => !inSection.has(k)).map(([, el]) => el)),
    ...Object.entries(m.sections || {}).flatMap(([title, keys]) => [h('div.section-title', title), h('div.fields', keys.map(k => controls[k]).filter(Boolean))])];
  const lines = fields.filter(([, f]) => f.type === 'json').map(([k, f]) => {
    const ed = lineEditor(f.cols, rec[k], lookups, !writable);
    get[k] = ed.get;
    return h('div.lines', h('h3', f.label), ed.el);
  });
  const reload = async goto => { invalidate(); setDirty(false); if (goto) location.hash = goto; else await formView(root, cfg, id, base); };
  const save = async () => {
    const body = Object.fromEntries(Object.entries(get).map(([k, fn]) => [k, fn()]));
    const missing = fields.filter(([k, f]) => f.req && k in get && (body[k] === '' || body[k] == null));
    if (missing.length) { missing.forEach(([k, f]) => fieldError(els[k], `${f.label} is required`)); els[missing[0][0]].focus(); return; }
    let saved;
    try { saved = await api(`/data/${cfg.table}${isNew ? '' : `/${id}`}`, { method: isNew ? 'POST' : 'PUT', body }); } catch (e) {
      const hit = fields.find(([, f]) => e.message.startsWith(f.label));          // show server validation next to the field
      if (hit && els[hit[0]]) { fieldError(els[hit[0]], e.message); els[hit[0]].focus(); return; }
      throw e;
    }
    toast('Saved', 'good'); invalidate(); setDirty(false);
    if (isNew) location.hash = `${base}/${saved.id}`; else await formView(root, cfg, id, base);
  };
  // Actions may ask for confirmation and/or a reason before they run.
  const runAction = a => async () => {
    const go = async note => { const msg = await a.run(rec, note); if (msg) toast(msg, 'good'); await reload(a.goto?.(rec)); };
    const text = typeof a.confirm === 'function' ? a.confirm(rec) : a.confirm;
    if (a.reason) reasonBox({ title: a.label, text: text || 'Please confirm.', label: a.label, required: a.reason === 'required', danger: a.danger }, go);
    else if (text) confirmBox(text, a.label, () => go(), { title: a.label, danger: a.danger });
    else await go();
  };
  const actions = (isNew ? [] : cfg.actions || []).filter(a => !a.show || a.show(rec));
  const buttons = bar => [
    ...actions.filter(a => !bar || a.primary).map(a => actionBtn(a.label, runAction(a), a.primary ? 'primary in-bar' : a.danger ? 'danger' : '')),
    writable ? actionBtn('Save', save, actions.some(a => a.primary) ? 'in-bar' : 'primary in-bar') : null,
    writable && !isNew && cfg.remove !== false && !bar ? h('button.btn.danger', { type: 'button', onclick: () => confirmBox(`Delete this ${m.label.toLowerCase()} record? This cannot be undone.`, 'Delete',
      async () => { await api(`/data/${cfg.table}/${id}`, { method: 'DELETE' }); invalidate(); setDirty(false); location.hash = base; }, { danger: true }) }, 'Delete') : null];
  const statusOpts = m.fields.status?.options;
  const sheet = h('section.card', statusOpts && !isNew ? h('header', h('div.statusbar', { 'aria-label': `Status: ${rec.status}` }, statusOpts.map(s => h('span', { class: s === rec.status ? 'on' : '' }, s)))) : null,
    h('div.body', blocks, lines, cfg.extra ? await cfg.extra(rec, reload).catch(e => { oops(e); return null; }) : null));
  root.replaceChildren(...page([h('a', { href: base }, cfg.title || m.label), h('span.sep', '/'), isNew ? 'New' : recordTitle(m, rec, lookups)], buttons(false),
    locked && typeof locked === 'string' ? h('div.banner', locked) : null, sheet));
  setDirty(false);
  if (writable) { watchDirty(sheet); setActionBar(buttons(true)); }
}

export const statusBadge = v => badge(v);
