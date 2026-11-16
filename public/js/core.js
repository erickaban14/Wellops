// Shared helpers: DOM builder, API client, lookups, formatting, dialogs.
export const state = { user: null, meta: null, company: 'WellOps ERP', mode: '', offline: false };

export function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el && !k.startsWith('data-')) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== '').map(k => (k instanceof Node ? k : String(k))));
  return el;
}
export const svg = (d, extra = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</g>${extra}`; return s; };

const setNet = off => { if (state.offline !== off) { state.offline = off; state.onNet?.(); } };
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch { setNet(true); throw Object.assign(new Error('No connection to the server'), { offline: true }); }
  setNet(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; location.hash = '#/login'; location.reload(); }
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  }
  return data;
}

// ---- cached table reads + display names ----
const cache = {};
export const rows = (table, where) => {
  if (where) return api(`/data/${table}?${new URLSearchParams(where)}`);
  return (cache[table] ||= api(`/data/${table}`).catch(e => { delete cache[table]; throw e; }));
};
export const invalidate = tables => (tables || Object.keys(cache)).forEach(t => delete cache[t]);
export const model = table => state.meta.models[table];
export const recLabel = (table, r) => { if (!r) return ''; const m = model(table); return r.code && r.name ? `${r.code} · ${r.name}` : String(r[m.display] ?? r.name ?? ''); };
export async function names(table) { try { return Object.fromEntries((await rows(table)).map(r => [r.id, recLabel(table, r)])); } catch { return {}; } }
export const can = (...mods) => state.user?.role === 'admin' || mods.some(m => state.user?.modules.includes(m));

// ---- formatting ----
export const fmtNum = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
export const fmtDate = v => (v ? String(v).slice(0, 10) : '');
export const fmtDT = v => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TONE = { good: ['approved', 'done', 'completed', 'received', 'paid', 'passed', 'valid', 'active', 'available', 'firmed', 'consolidated', 'confirmed', 'assigned', 'posted', 'ok', 'producing', 'online'],
  warn: ['pending', 'pending approval', 'planned', 'requested', 'in progress', 'partially received', 'partial', 'captured', 'submitted', 'expiring', 'maintenance', 'scheduled', 'sent', 'quoted', 'rfq', 'on hold', 'offline', 'deployed', 'drilling'],
  bad: ['rejected', 'failed', 'expired', 'missing', 'shortage', 'cancelled', 'error', 'retired', 'inactive'], info: ['draft', 'open', 'quotation', 'converted', 'ordered'] };
export const tone = v => Object.keys(TONE).find(k => TONE[k].includes(String(v).toLowerCase())) || '';
export const badge = (v, t) => (v == null || v === '' ? '' : h('span.badge', { class: t ?? tone(v) }, String(v)));
export function fmtField(f, v, lookups = {}) {
  if (v == null || v === '') return '';
  if (f.type === 'ref') return lookups[f.ref]?.[v] || '';
  if (f.type === 'number') return fmtNum(v);
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'datetime') return fmtDT(v);
  if (f.type === 'bool') return v ? 'Yes' : '';
  if (f.type === 'select' && (f.options || []).length < 12 && /status|state/.test(f.label.toLowerCase())) return badge(v);
  return String(v);
}

// ---- feedback ----
export function toast(msg, kind = '') {
  const el = h('div.toast', { class: kind }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3200);
}
export const oops = e => toast(e.message || String(e), 'bad');
export function modal(title, body, buttons = []) {
  const close = () => ov.remove();
  const ov = h('div.overlay', { onclick: e => e.target === ov && close() },
    h('div.modal', { role: 'dialog', 'aria-label': title }, h('header', title), h('div.body', body),
      h('footer', h('button.btn', { onclick: close }, 'Close'), buttons.map(b => h('button.btn', { class: b.primary ? 'primary' : b.danger ? 'danger' : '',
        onclick: async ev => { ev.target.disabled = true; try { if (await b.run() !== false) close(); } catch (e) { oops(e); } ev.target.disabled = false; } }, b.label)))));
  document.body.append(ov);
  return close;
}
export const confirmBox = (text, label, run) => modal('Please confirm', h('p', text), [{ label, primary: true, run }]);

// Button that runs an async action with error handling and disables itself while busy.
export const actionBtn = (label, run, cls = '') => h('button.btn', { class: cls, onclick: async e => {
  const b = e.currentTarget; b.disabled = true;
  try { await run(); } catch (err) { oops(err); }
  b.disabled = false;
} }, label);

export function simpleTable(cols, data, { cards = true, onRow, empty = 'Nothing to show' } = {}) {
  if (!data.length) return h('div.empty', empty);
  return h('div.table-wrap', h('table', { class: cards ? 'cards' : '' },
    h('thead', h('tr', cols.map(c => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', data.map(r => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      cols.map(c => h('td', { class: c.num ? 'num' : '', 'data-label': c.label }, c.get ? c.get(r) : r[c.key])))))));
}
export const page = (title, tools, ...content) => [h('div.control', h('h1', title), tools), ...content].flat().filter(x => x != null && x !== false);
export const card = (title, tools, ...content) => h('section.card', title || tools ? h('header', h('h2', title), tools) : null, ...content);
export const field = (label, input, cls = '') => h('div.field', { class: cls }, h('label', label), input);
export const select = (options, value, attrs = {}) => h('select', attrs, options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value ?? '') }, l); }));
