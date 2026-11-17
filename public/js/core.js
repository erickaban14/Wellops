// Shared helpers: DOM builder, API client, lookups, formatting, dialogs, pickers, theme.
export const state = { user: null, meta: null, company: 'ProStars ERP', currency: 'USD', mode: '', offline: false, dirty: false };

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
    else if (k in el && k !== 'list' && !k.startsWith('data-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== '').map(k => (k instanceof Node ? k : String(k))));
  return el;
}
export const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</g>`; return s; };

// ---- theme: auto (device), light or dark ----
export const themePref = () => { try { return localStorage.getItem('wo_theme') || 'auto'; } catch { return 'auto'; } };
export function applyTheme(pref) {
  if (pref) try { localStorage.setItem('wo_theme', pref); } catch { /* private mode */ }
  const p = themePref(), dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
applyTheme();

// ---- API ----
const setNet = off => { if (state.offline !== off) { state.offline = off; state.onNet?.(); } };
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch { setNet(true); throw Object.assign(new Error('No connection to the server'), { offline: true }); }
  setNet(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; state.dirty = false; location.hash = '#/login'; location.reload(); }
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const cap = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
export const fmtNum = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
export const fmtMoney = (v, d = 0) => (v == null || v === '' ? '' : `${state.currency} ${fmtNum(v, d)}`);
// One unambiguous date format everywhere: 16 Nov 2026. Date-times are shown in site time (stored as UTC wall-clock).
export const fmtDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ''; };
export const fmtDT = v => { if (!v) return ''; const s = new Date(v).toISOString(); return `${fmtDate(s).replace(/ \d{4}$/, '')}, ${s.slice(11, 16)}`; };
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const roleLabel = k => state.meta?.roles[k]?.label || cap(String(k || '').replace(/_/g, ' '));
const TONE = { good: ['approved', 'done', 'completed', 'received', 'paid', 'passed', 'valid', 'active', 'available', 'firmed', 'consolidated', 'confirmed', 'assigned', 'posted', 'ok', 'producing', 'online'],
  warn: ['pending', 'pending approval', 'planned', 'requested', 'in progress', 'partially received', 'partial', 'captured', 'submitted', 'expiring', 'maintenance', 'scheduled', 'sent', 'quoted', 'rfq', 'on hold', 'offline', 'deployed', 'drilling'],
  bad: ['rejected', 'failed', 'expired', 'missing', 'shortage', 'cancelled', 'error', 'retired', 'inactive'], info: ['draft', 'open', 'quotation', 'converted', 'ordered'] };
export const tone = v => Object.keys(TONE).find(k => TONE[k].includes(String(v).toLowerCase())) || '';
export const badge = (v, t) => (v == null || v === '' ? '' : h('span.badge', { class: t ?? tone(v) }, cap(v)));
export function fmtField(f, v, lookups = {}) {
  if (v == null || v === '') return '';
  if (f.type === 'ref') return lookups[f.ref]?.[v] || '';
  if (f.type === 'number') return fmtNum(v);
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'datetime') return fmtDT(v);
  if (f.type === 'bool') return v ? 'Yes' : '';
  if (state.meta?.roles[v] && /role|approver/i.test(f.label)) return roleLabel(v);
  if (f.type === 'select' && /status|state/i.test(f.label)) return badge(v);
  if (f.type === 'select') return cap(v);
  return String(v);
}
export const fieldLabel = f => f.label + (f.money ? ` (${state.currency})` : '');

// ---- feedback ----
export function toast(msg, kind = '') {
  const el = h('div.toast', { class: kind, role: kind === 'bad' ? 'alert' : 'status' }, h('span', msg), h('button', { 'aria-label': 'Dismiss', onclick: () => el.remove() }, '✕'));
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 3500);
}
export const oops = e => toast(e.message || String(e), 'bad');

// Accessible dialog: focus is trapped inside, Esc closes, focus returns to the element that opened it.
export function modal(title, body, buttons = [], { closeLabel = 'Cancel' } = {}) {
  const opener = document.activeElement;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); opener?.focus?.(); };
  const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', title), h('div.body', body),
    h('footer', h('button.btn', { onclick: () => close() }, closeLabel), buttons.map(b => h('button.btn', { class: b.primary ? 'primary' : b.danger ? 'danger' : '',
      onclick: async ev => { const btn = ev.currentTarget; btn.disabled = true; try { if (await b.run() !== false) close(); } catch (e) { oops(e); } btn.disabled = false; } }, b.label))));
  const ov = h('div.overlay', { onmousedown: e => e.target === ov && close() }, box);
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  (box.querySelector('.body input, .body textarea, .body select') || box.querySelector('footer .btn.primary') || box.querySelector('footer .btn')).focus();
  return close;
}
export const confirmBox = (text, label, run, opts = {}) => modal(opts.title || 'Please confirm', h('p', { style: { margin: 0 } }, text), [{ label, primary: !opts.danger, danger: opts.danger, run }]);
// Confirmation that also captures a reason (required for rejections).
export function reasonBox({ title, text, label, required, danger }, run) {
  const note = h('textarea', { id: 'reason_note', placeholder: required ? 'Reason (required)' : 'Note (optional)' }), err = h('div.err', { hidden: true }, 'Please enter a reason.');
  modal(title, h('div', h('p', { style: { marginTop: 0 } }, text), h('div.field', h('label', { htmlFor: 'reason_note' }, required ? 'Reason *' : 'Note'), note, err)), [{ label, primary: !danger, danger,
    run: async () => { if (required && !note.value.trim()) { err.hidden = false; note.parentNode.classList.add('invalid'); note.focus(); return false; } await run(note.value.trim()); } }]);
}

// Button that runs an async action with error handling and disables itself while busy.
export const actionBtn = (label, run, cls = '') => h('button.btn', { class: cls, type: 'button', onclick: async e => {
  const b = e.currentTarget; b.disabled = true;
  try { await run(); } catch (err) { oops(err); }
  b.disabled = false;
} }, label);

// Rows that open a record are reachable by keyboard (Tab, Enter).
export const rowAttrs = open => (open ? { class: 'click', tabIndex: 0, role: 'link', onclick: open, onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } } : {});
export function simpleTable(cols, data, { cards = true, onRow, empty = 'Nothing to show' } = {}) {
  if (!data.length) return h('div.empty', empty);
  return h('div.table-wrap', h('table', { class: cards ? (onRow ? 'cards compact' : 'cards') : '' },
    h('thead', h('tr', cols.map(c => h('th', { class: c.num ? 'num' : '', scope: 'col' }, c.label)))),
    h('tbody', data.map(r => h('tr', rowAttrs(onRow ? () => onRow(r) : null),
      cols.map((c, i) => h('td', { class: [c.num ? 'num' : '', onRow && i > 3 && i < cols.length - 1 ? 'c-hide' : ''].join(' ').trim(), 'data-label': c.label }, c.get ? c.get(r) : r[c.key])))))));
}
export const page = (title, tools, ...content) => [h('div.control', h('h1', title), h('div.row.acts', tools)), ...content].flat().filter(x => x != null && x !== false);
export const card = (title, tools, ...content) => h('section.card', title || tools ? h('header', h('h2', title), tools) : null, ...content);

// Label + control, always linked so screen readers and label taps work.
let uid = 0;
export function field(label, input, cls = '') {
  const target = input.matches?.('input, select, textarea') ? input : input.querySelector?.('input, select, textarea');
  if (target && !target.id) target.id = `c${++uid}`;
  return h('div.field', { class: cls }, h('label', { htmlFor: target?.id }, label), input);
}
export const fieldError = (input, msg) => {
  const f = input.closest('.field'); if (!f) return;
  f.querySelector('.err')?.remove(); f.classList.toggle('invalid', !!msg);
  if (msg) f.append(h('div.err', { role: 'alert' }, msg));
};
export const select = (options, value, attrs = {}) => h('select', attrs, options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, cap(o)]; return h('option', { value: v, selected: String(v) === String(value ?? '') }, l); }));

// Type-to-search picker for long lists (employees, items…). Short lists stay as a plain dropdown.
export function picker(options, value, attrs = {}) {
  if (options.length <= 12) return select([['', ''], ...options], value, attrs);
  const id = `dl${++uid}`, byLabel = new Map(options.map(([v, l]) => [l, v])), byVal = new Map(options);
  let cur = byVal.has(value) ? value : '';
  const input = h('input', { type: 'text', list: id, value: byVal.get(cur) || '', placeholder: 'Type to search…', autocomplete: 'off', disabled: attrs.disabled, 'aria-label': attrs['aria-label'] });
  const wrap = h('div.picker', input, h('datalist', { id }, options.map(([, l]) => h('option', { value: l }))));
  input.addEventListener('change', () => {
    const v = input.value ? byLabel.get(input.value) : '';
    if (v === undefined) input.value = byVal.get(cur) || ''; else cur = v;      // unknown text: keep the previous choice
    attrs.onchange?.({ target: wrap });
  });
  Object.defineProperty(wrap, 'value', { get: () => cur, set: v => { cur = byVal.has(v) ? v : ''; input.value = byVal.get(cur) || ''; } });
  return wrap;
}

// Number input with large - / + buttons for touch and gloved use.
export function stepper(input, step = 1) {
  const bump = d => { input.value = Math.max(Number(input.min) || 0, (Number(input.value) || 0) + d); input.dispatchEvent(new Event('input', { bubbles: true })); };
  return h('div.stepper', h('button.btn', { type: 'button', 'aria-label': 'Decrease', disabled: input.disabled, onclick: () => bump(-step) }, '−'), input,
    h('button.btn', { type: 'button', 'aria-label': 'Increase', disabled: input.disabled, onclick: () => bump(step) }, '+'));
}

// Sticky action bar at the bottom of the screen on phones (cleared on every navigation).
export function setActionBar(buttons) {
  document.querySelector('.actionbar')?.remove();
  const list = (buttons || []).flat().filter(Boolean);
  document.body.classList.toggle('has-actionbar', !!list.length);
  if (list.length) document.body.append(h('div.actionbar', { role: 'toolbar', 'aria-label': 'Actions' }, list));
}

// Unsaved-changes tracking. Forms call watchDirty(container); the router asks before leaving.
export const setDirty = v => { state.dirty = !!v; };
export const watchDirty = el => ['input', 'change'].forEach(ev => el.addEventListener(ev, () => { state.dirty = true; }));
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
