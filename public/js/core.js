// Shared helpers: DOM builder, API client, lookups, formatting, dialogs, pickers, theme.
export const state = { user: null, meta: null, company: 'ProStars ERP', currency: 'OMR', symbol: '⃄', mode: '', offline: false, dirty: false };

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

// ---- Omani rial sign ----
// U+20C4 is new (Unicode 18, 2026): many phones have no font for it and draw an empty box.
// Detect that once and show the Arabic abbreviation ر.ع. instead (isolated so it stays in place next to the number).
const OMR_SIGN = '⃄', OMR_FALLBACK = '⁨ر.ع.⁩';
const signMissing = (() => {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), draw = ch => { x.clearRect(0, 0, 32, 32); x.font = '24px sans-serif'; x.fillText(ch, 4, 26); return x.getImageData(0, 0, 32, 32).data.join(); };
    return draw(OMR_SIGN) === draw('͸');   // same pixels as an unassigned code point = no glyph
  } catch { return false; }
})();
const omrReviver = signMissing ? (k, v) => (typeof v === 'string' && v.includes(OMR_SIGN) ? v.replaceAll(OMR_SIGN, OMR_FALLBACK) : v) : undefined;
if (signMissing) state.symbol = OMR_FALLBACK;

// ---- API ----
const setNet = off => { if (state.offline !== off) { state.offline = off; state.onNet?.(); } };
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch { setNet(true); throw Object.assign(new Error('No connection to the server'), { offline: true }); }
  setNet(false);
  const data = await res.text().then(t => JSON.parse(t, omrReviver)).catch(() => null);
  if (data === null && res.ok) {   // free hosts sometimes answer with an HTML browser-check page: reload so the browser passes it (at most once a minute)
    let last = 0; try { last = +sessionStorage.getItem('wo_challenge') || 0; } catch {}
    if (Date.now() - last > 60000) {
      try { sessionStorage.setItem('wo_challenge', String(Date.now())); } catch {}
      location.reload(); return new Promise(() => {});
    }
    throw Object.assign(new Error('The server is busy (browser check). Reload the page in a moment.'), { status: 503 });
  }
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; state.dirty = false; location.hash = '#/login'; location.reload(); }
    throw Object.assign(new Error(data?.error || res.statusText), { status: res.status });
  }
  return data ?? {};
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
// Omani rial: 3 decimals (baisa), official sign U+20C4 before the amount (both come from Settings).
export const MONEY_DP = 3;
export const fmtMoney = (v, d = MONEY_DP) => (v == null || v === '' ? '' : `${state.symbol} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
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
  if (f.type === 'number') return f.money ? fmtNum(v, MONEY_DP) : fmtNum(v);
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'datetime') return fmtDT(v);
  if (f.type === 'bool') return v ? 'Yes' : '';
  if (state.meta?.roles[v] && /role|approver/i.test(f.label)) return roleLabel(v);
  if (f.type === 'select' && /status|state/i.test(f.label)) return badge(v);
  if (f.type === 'select') return cap(v);
  return String(v);
}
export const fieldLabel = f => f.label + (f.money ? ` (${state.symbol})` : '');

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

// SAP-style value help for a link field: type for suggestions (↑ ↓ Enter), F4 or the list button opens a searchable
// table, the arrow opens the linked record. opts.filter(r) narrows the choices (e.g. wells of the chosen customer).
export function valueHelp(table, value, { disabled, filter, onpick, label } = {}) {
  const m = model(table);
  const extra = Object.entries(m.fields).filter(([k, f]) => !f.hidden && k !== m.display && !['json', 'longtext', 'bool', 'datetime'].includes(f.type)).slice(0, 3);
  let all = [], lk = {}, cur = value || '', hits = [], active = -1;
  const load = (async () => {
    all = await rows(table);
    await Promise.all([...new Set(extra.map(([, f]) => f.ref).filter(Boolean))].map(async t => { lk[t] = await names(t); }));
  })();
  const byId = id => all.find(r => r.id === id);
  const labelOf = id => recLabel(table, byId(id));
  const sub = r => extra.map(([k, f]) => plainText(fmtField(f, r[k], lk))).filter(Boolean).join(' · ');
  const choices = () => all.filter(r => !filter || filter(r));
  const match = (r, q) => !q || `${recLabel(table, r)} ${sub(r)}`.toLowerCase().includes(q);
  const input = h('input', { type: 'text', autocomplete: 'off', disabled, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-label': label, placeholder: disabled ? '' : 'Type to search, F4 for list' });
  const list = h('ul.vh-list', { role: 'listbox', hidden: true });
  const link = h('a.vh-link', { title: `Open this ${m.label.replace(/s$/, '').toLowerCase()}`, 'aria-label': 'Open linked record', hidden: true }, '➜');
  const btn = h('button.vh-btn', { type: 'button', title: `Choose from list (F4)`, 'aria-label': `Choose ${label || m.label} from list`, disabled }, '☰');
  const wrap = h('div.vh', input, btn, link, list);
  const sync = () => {
    input.value = cur ? labelOf(cur) : '';
    const href = cur && state.hrefFor?.(table);
    link.hidden = !href; if (href) link.href = `${href}/${cur}`;
  };
  const pick = r => {
    cur = r ? r.id : ''; sync(); close();
    wrap.dispatchEvent(new Event('change', { bubbles: true }));
    onpick?.(r || null);
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const show = () => {
    const q = input.value.trim().toLowerCase();
    hits = choices().filter(r => match(r, q === labelOf(cur).toLowerCase() ? '' : q)).slice(0, 8);
    list.replaceChildren(...(hits.length ? hits.map((r, i) => h('li', { role: 'option', class: i === active ? 'on' : '', 'aria-selected': String(r.id === cur),
      onmousedown: e => { e.preventDefault(); pick(r); } }, h('strong', recLabel(table, r)), h('small', sub(r)))) : [h('li.none', 'No match. Press F4 to browse all.')]));
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const dialog = async () => {
    await load;
    const q = h('input.search', { type: 'search', placeholder: `Search ${m.label.toLowerCase()}…`, 'aria-label': `Search ${m.label}` });
    const body = h('div.vh-table');
    let close2;
    const draw = () => {
      const s = q.value.trim().toLowerCase(), data = choices().filter(r => match(r, s));
      body.replaceChildren(simpleTable([{ label: m.fields[m.display]?.label || 'Name', get: r => recLabel(table, r) }, ...extra.map(([k, f]) => ({ label: f.label, get: r => fmtField(f, r[k], lk), num: f.type === 'number' }))],
        data, { onRow: r => { close2(); pick(r); }, empty: 'Nothing matches your search.' }));
    };
    q.addEventListener('input', draw);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); body.querySelector('tr.click')?.click(); } });
    draw();
    close2 = modal(`Choose ${m.label.replace(/s$/, '')}${choices().length < all.length ? ' (filtered by this form)' : ''}`, h('div', q, body), cur ? [{ label: 'Clear selection', run: () => pick(null) }] : []);
  };
  input.addEventListener('focus', async () => { await load; input.select(); });
  input.addEventListener('input', async () => { await load; active = -1; show(); });
  input.addEventListener('keydown', async e => {
    if (e.key === 'F4' || (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); close(); return dialog(); }
    if (list.hidden && e.key === 'ArrowDown') { await load; show(); return; }
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(hits.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); show(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hits[Math.max(active, 0)]) pick(hits[Math.max(active, 0)]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); sync(); }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (!list.hidden) close();
    if (!input.value.trim() && cur) pick(null); else sync();    // unknown text falls back to the current choice
  }, 120));
  btn.addEventListener('click', dialog);
  Object.defineProperty(wrap, 'value', { get: () => cur, set: v => { cur = v || ''; load.then(sync); } });
  wrap.record = () => byId(cur) || null;
  wrap.ready = load;
  load.then(sync);
  return wrap;
}
const plainText = v => (v instanceof Node ? v.textContent : String(v ?? ''));

// Choice between a few options as one-tap buttons (radio group) instead of a dropdown.
export function segmented(options, value, { disabled, label } = {}) {
  let cur = value ?? '';
  const opts = options.map(o => (Array.isArray(o) ? o : [o, cap(o)])), vals = opts.map(o => o[0]);
  const wrap = h('div.segctl', { role: 'radiogroup', 'aria-label': label });
  const fire = () => wrap.dispatchEvent(new Event('change', { bubbles: true }));
  const draw = () => wrap.replaceChildren(...opts.map(([o, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(o === cur), class: o === cur ? 'on' : '', disabled,
    tabIndex: o === cur || (!cur && o === vals[0]) ? 0 : -1,
    onclick: () => { cur = o; draw(); fire(); },
    onkeydown: e => { const i = vals.indexOf(cur), d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (d) { e.preventDefault(); cur = vals[(i + d + vals.length) % vals.length]; draw(); wrap.querySelector('.on')?.focus(); fire(); } } }, l)));
  draw();
  Object.defineProperty(wrap, 'value', { get: () => cur, set: v => { cur = v ?? ''; draw(); } });
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
