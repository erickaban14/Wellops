// Generic list and form views generated from the model metadata (server/models.js).
import { actionBtn, api, badge, can, card, confirmBox, field, fmtField, fmtNum, h, invalidate, model, names, oops, page, rows, select, state, toast } from './core.js';

const visible = m => Object.entries(m.fields).filter(([, f]) => !f.hidden);
async function lookupsFor(m, keys) {
  const out = {};
  await Promise.all([...new Set(keys.map(k => m.fields[k]?.ref).filter(Boolean))].map(async t => { out[t] = await names(t); }));
  return out;
}

export async function listView(root, cfg, base) {
  const m = model(cfg.table);
  const cols = cfg.cols || visible(m).filter(([, f]) => !['json', 'longtext'].includes(f.type)).map(([k]) => k).slice(0, 7);
  let data = await rows(cfg.table);
  if (cfg.mine) data = data.filter(r => r.employee_id === state.user.employee_id);
  if (cfg.filter) data = data.filter(cfg.filter);
  if (cfg.sort) data = [...data].sort(cfg.sort); else if (m.fields.status || cfg.newest) data = [...data].reverse();
  const lookups = await lookupsFor(m, cols);
  const writable = can(...m.modules) && cfg.create !== false && !cfg.readonly;
  const statuses = m.fields.status?.options || [];
  let q = '', chip = '';
  const body = h('div');
  const text = r => cols.map(k => { const v = fmtField(m.fields[k], r[k], lookups); return v instanceof Node ? v.textContent : v; }).join(' ').toLowerCase();
  const draw = () => {
    const shown = data.filter(r => (!chip || r.status === chip) && (!q || text(r).includes(q)));
    body.replaceChildren(!shown.length ? h('div.empty', data.length ? 'No records match your filter.' : `No ${m.label.toLowerCase()} yet.`) :
      h('div.table-wrap', h('table.cards', h('thead', h('tr', cols.map(k => h('th', { class: m.fields[k].type === 'number' ? 'num' : '' }, m.fields[k].label)))),
        h('tbody', shown.slice(0, 300).map(r => h('tr.click', { onclick: () => { location.hash = `${base}/${r.id}`; } },
          cols.map(k => h('td', { class: m.fields[k].type === 'number' ? 'num' : '', 'data-label': m.fields[k].label }, fmtField(m.fields[k], r[k], lookups)))))))),
      shown.length > 300 ? h('div.empty', `Showing first 300 of ${shown.length}. Use search to narrow down.`) : null);
  };
  const chips = statuses.length ? h('div.chips', ['', ...statuses].map(s => h('button.chip', { class: s === '' ? 'on' : '', onclick: e => {
    chip = s; e.currentTarget.parentNode.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); e.currentTarget.classList.add('on'); draw(); } }, s || 'All'))) : null;
  root.replaceChildren(...page(cfg.title || m.label, [
    h('input.search', { type: 'search', placeholder: 'Search…', 'aria-label': 'Search', oninput: e => { q = e.target.value.toLowerCase(); draw(); } }),
    (cfg.toolbar || []).filter(t => !t.show || t.show()).map(t => actionBtn(t.label, async () => { const msg = await t.run(); invalidate(); if (msg) toast(msg, 'good'); await listView(root, cfg, base); })),
    writable ? h('a.btn.primary', { href: `${base}/new` }, 'New') : null,
  ], cfg.intro ? h('div.banner', cfg.intro) : null, chips ? h('div', { style: { marginBottom: '10px' } }, chips) : null, card(null, null, body)));
  draw();
}

// Editable sub-table for JSON line fields (PO lines, RFQ lines…)
export function lineEditor(cols, lines, lookups, disabled) {
  const data = (lines || []).map(l => ({ ...l }));
  const tbody = h('tbody'), total = h('td.num');
  const hasTotal = cols.some(c => c[0] === 'qty') && cols.some(c => c[0] === 'price');
  const sum = () => { if (hasTotal) total.textContent = fmtNum(data.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0)); };
  const input = (l, [name, type = 'text', o = {}]) => {
    const set = e => { l[name] = type === 'bool' ? e.target.checked : e.target.value; sum(); };
    if (type === 'ref') return select([['', ''], ...Object.entries(lookups[o.ref] || {})], l[name], { onchange: set, disabled });
    if (type === 'select') return select(['', ...o.options], l[name], { onchange: set, disabled });
    if (type === 'bool') return h('input', { type: 'checkbox', checked: !!l[name], onchange: set, disabled });
    return h('input', { type: type === 'number' ? 'number' : type === 'time' ? 'time' : 'text', step: 'any', value: l[name] ?? '', oninput: set, disabled });
  };
  const label = c => c[2]?.label || c[0].replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
  const draw = () => { tbody.replaceChildren(...data.map((l, i) => h('tr', cols.map(c => h('td', { 'data-label': label(c) }, input(l, c))),
    h('td', disabled ? null : h('button.btn.small.danger', { type: 'button', 'aria-label': 'Remove line', onclick: () => { data.splice(i, 1); draw(); } }, '✕'))))); sum(); };
  draw();
  const el = h('div', h('div.table-wrap', h('table.cards', h('thead', h('tr', cols.map(c => h('th', label(c))), h('th'))), tbody,
    hasTotal ? h('tfoot', h('tr', h('td', { colSpan: cols.length - 1 }, 'Total'), total, h('td'))) : null)),
    disabled ? null : h('button.btn.small', { type: 'button', style: { marginTop: '8px' }, onclick: () => { data.push({}); draw(); } }, '+ Add line'));
  return { el, get: () => data.filter(l => Object.values(l).some(v => v !== '' && v != null)) };
}

export async function formView(root, cfg, id, base) {
  const m = model(cfg.table), isNew = id === 'new';
  const rec = isNew ? { ...(cfg.defaults?.() || {}) } : await api(`/data/${cfg.table}/${id}`);
  const fields = visible(m).filter(([k, f]) => f.type !== 'json' || f.cols);
  const lineCols = fields.filter(([, f]) => f.type === 'json').flatMap(([, f]) => f.cols.map(c => c[2]?.ref).filter(Boolean));
  const lookups = await lookupsFor(m, fields.map(([k]) => k));
  await Promise.all([...new Set(lineCols)].map(async t => { lookups[t] = await names(t); }));
  const locked = cfg.locked?.(rec) || false;
  const writable = can(...m.modules) && !cfg.readonly && !locked;
  const get = {};
  const inputs = fields.filter(([, f]) => f.type !== 'json').map(([k, f]) => {
    const dis = !writable || (f.ro && true) || (cfg.mine && k === 'employee_id') || (cfg.lockFields || []).includes(k);
    let el;
    if (f.type === 'ref') el = select([['', ''], ...Object.entries(lookups[f.ref] || {}).sort((a, b) => a[1].localeCompare(b[1]))], rec[k], { disabled: dis });
    else if (f.type === 'select') el = select(f.options.includes('') ? f.options : ['', ...f.options], rec[k], { disabled: dis });
    else if (f.type === 'bool') el = h('input', { type: 'checkbox', checked: !!rec[k], disabled: dis });
    else if (f.type === 'longtext') el = h('textarea', { value: rec[k] ?? '', disabled: dis });
    else el = h('input', { type: { number: 'number', date: 'date' }[f.type] || 'text', step: 'any', disabled: dis,
      value: f.type === 'datetime' && rec[k] ? new Date(rec[k]).toLocaleString() : rec[k] ?? '', placeholder: f.auto && isNew ? 'Auto' : '' });
    if (!dis && f.type !== 'datetime') get[k] = () => (f.type === 'bool' ? el.checked : el.value);
    el.id = `f_${k}`;
    return h('div.field', { class: f.type === 'bool' ? 'check' : f.type === 'longtext' ? 'wide' : '' }, h('label', { htmlFor: el.id }, f.label + (f.req ? ' *' : '')), el);
  });
  const lines = fields.filter(([, f]) => f.type === 'json').map(([k, f]) => {
    const ed = lineEditor(f.cols, rec[k], lookups, !writable);
    get[k] = ed.get;
    return h('div.lines', h('h3', f.label), ed.el);
  });
  const reload = async goto => { invalidate(); if (goto) location.hash = goto; else await formView(root, cfg, id, base); };
  const save = async () => {
    const body = Object.fromEntries(Object.entries(get).map(([k, fn]) => [k, fn()]));
    const saved = await api(`/data/${cfg.table}${isNew ? '' : `/${id}`}`, { method: isNew ? 'POST' : 'PUT', body });
    toast('Saved', 'good'); invalidate();
    if (isNew) location.hash = `${base}/${saved.id}`; else await formView(root, cfg, id, base);
  };
  const statusOpts = m.fields.status?.options;
  const title = isNew ? 'New' : String(rec[m.display] ?? rec.name ?? '') || m.label;
  root.replaceChildren(...page([h('a', { href: base }, cfg.title || m.label), h('span.sep', '/'), title], [
    (isNew ? [] : cfg.actions || []).filter(a => !a.show || a.show(rec)).map(a => actionBtn(a.label, async () => { const msg = await a.run(rec); if (msg) toast(msg, 'good'); await reload(a.goto?.(rec)); }, a.primary ? 'primary' : a.danger ? 'danger' : '')),
    writable ? actionBtn('Save', save, 'primary') : null,
    writable && !isNew && cfg.remove !== false ? h('button.btn.danger', { onclick: () => confirmBox(`Delete this ${m.label.toLowerCase()} record?`, 'Delete', async () => { await api(`/data/${cfg.table}/${id}`, { method: 'DELETE' }); invalidate(); location.hash = base; }) }, 'Delete') : null,
  ], locked && typeof locked === 'string' ? h('div.banner', locked) : null,
  h('section.card', statusOpts && !isNew ? h('header', h('div.statusbar', statusOpts.map(s => h('span', { class: s === rec.status ? 'on' : '' }, s)))) : null,
    h('div.body', h('div.fields', inputs), lines, cfg.extra ? await cfg.extra(rec, reload).catch(e => { oops(e); return null; }) : null))));
}

export const statusBadge = v => badge(v);
