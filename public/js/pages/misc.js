// Login (password / face / demo role), profile, finance reports, document files, on-prem sync.
import { actionBtn, api, badge, can, card, field, fieldError, fmtDT, fmtNum, h, invalidate, modal, names, oops, page, roleLabel, rows, select, simpleTable, state, toast } from '../core.js';

// ---------- Face recognition (face-api.js, loaded on demand) ----------
const FACE_LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js';
const FACE_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
let faceReady;
const loadFace = () => (faceReady ||= new Promise((ok, fail) => {
  const s = document.createElement('script'); s.src = FACE_LIB; s.onerror = () => { faceReady = null; fail(new Error('Could not load the face recognition library (needs internet access).')); };
  s.onload = () => Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS), faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS), faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS)]).then(ok, fail);
  document.head.append(s);
}));
// Opens the camera, waits for one clear face and resolves with its 128-number descriptor.
function captureFace(title) {
  return new Promise((resolve, reject) => {
    const video = h('video.cam', { autoplay: true, muted: true, playsInline: true }), status = h('p.muted', 'Starting camera…');
    let stream, done = false;
    const stop = () => { done = true; stream?.getTracks().forEach(t => t.stop()); };
    const close = modal(title, h('div', video, status));
    const ov = document.querySelector('.overlay:last-of-type');
    new MutationObserver((_, o) => { if (!document.body.contains(ov)) { o.disconnect(); if (!done) { stop(); reject(new Error('Face capture cancelled')); } } }).observe(document.body, { childList: true });
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera (HTTPS or localhost is required).');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      video.srcObject = stream;
      status.textContent = 'Loading recognition models…';
      await loadFace();
      status.textContent = 'Look straight at the camera…';
      for (let i = 0; i < 40 && !done; i++) {
        const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.6 })).withFaceLandmarks().withFaceDescriptor();
        if (det) { stop(); close(); return resolve(Array.from(det.descriptor)); }
        await new Promise(r => setTimeout(r, 350));
      }
      if (!done) throw new Error('No face detected. Check the lighting and try again.');
    })().catch(e => { if (!done) { stop(); close(); reject(e.name === 'NotAllowedError' ? new Error('Camera permission was denied.') : e); } });
  });
}

// After a face login the field VPN client is started through the configured URL / deep link.
function startVpn(url) {
  if (!url) return toast('Signed in by face. No VPN connect URL is configured (Settings › Parameters › vpn_connect_url).');
  const frame = h('iframe', { hidden: true, src: url });
  document.body.append(frame);
  setTimeout(() => frame.remove(), 4000);
  toast('Signed in by face - VPN client activation requested', 'good');
}

// The logo is public/icon.svg - replace that one file to rebrand the login page, top bar, favicon and app icon.
const brand = () => h('div', { style: { textAlign: 'center' } }, h('img.logo.big', { src: '/icon.svg', alt: '' }), h('h1', 'ProStars ERP'), h('div.muted', 'Wells · Rigs · Pumps operations'));

export async function loginPage(root, boot) {
  let pub = { roles: {}, demo_login: false };
  try { pub = await api('/public'); } catch (e) { if (e.offline) return root.replaceChildren(h('div.login', h('div.card', brand(), h('p.muted', 'No connection, and nobody has signed in on this device yet. Connect once to sign in; after that, Daily Work Tickets work offline.'),
    h('button.btn.primary', { onclick: () => location.reload() }, 'Try again')))); }
  if (pub.ready === false) { setTimeout(() => loginPage(root, boot), 8000); return root.replaceChildren(h('div.login', h('div.card', brand(), h('div.banner', { class: pub.error ? 'bad' : '', style: { marginTop: '14px' }, role: 'status' }, pub.error || 'Preparing the database for first use. This page refreshes by itself.')))); }
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'name@company.com' }), pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div.banner.bad', { hidden: true });
  const attempt = async fn => { err.hidden = true; try { const r = await fn(); await boot(); return r; } catch (e) { err.textContent = e.message; err.hidden = false; } };
  const groups = {};
  for (const [k, r] of Object.entries(pub.roles)) (groups[r.group] ||= []).push([k, r.label]);
  const role = h('select', { 'aria-label': 'Demo role' }, Object.entries(groups).map(([g, list]) => h('optgroup', { label: g }, list.map(([k, l]) => h('option', { value: k, selected: k === 'rig_manager' }, l)))));
  root.replaceChildren(h('div.login', h('div.card',
    brand(),
    h('form', { noValidate: false, onsubmit: e => { e.preventDefault(); attempt(() => api('/login', { body: { email: email.value, password: pw.value } })); } },
      err, field('Email', email), field('Password', pw), h('button.btn.primary', { type: 'submit' }, 'Sign in'), h('p.muted', { style: { margin: 0, fontSize: '12.5px', textAlign: 'center' } }, 'Forgot your password? Ask your system administrator to reset it.')),
    h('div.or', 'or'),
    h('button.btn', { onclick: () => attempt(async () => { const d = await captureFace('Face login'); const r = await api('/face/login', { body: { descriptor: d } }); startVpn(r.vpn_connect_url); }) }, 'Sign in with face recognition'),
    pub.demo_login ? [h('div.or', 'Demo: open the system as any role profile'), h('div.row', { style: { flexWrap: 'nowrap' } }, role, h('button.btn.primary', { style: { width: 'auto' }, onclick: () => attempt(() => api('/demo-login', { body: { role: role.value } })) }, 'Enter'))] : null)));
}

const pwField = (label, auto) => { const i = h('input', { type: 'password', autocomplete: auto, minLength: 8 }); return [i, field(label, i)]; };
// Settings > Users: an administrator sets a temporary password (there is no e-mail service for self-service resets).
export async function resetPassword(rec, reload) {
  if (!rec.id || state.user.role !== 'admin') return null;
  const [pw, el] = pwField('New temporary password (min. 8 characters)', 'new-password');
  return h('div.lines', h('h3', 'Reset password'), h('p.muted', 'Use this when someone has forgotten their password. Give them the temporary password and ask them to change it under My Space › Profile.'),
    h('div.row', { style: { alignItems: 'flex-end' } }, h('div', { style: { maxWidth: '320px', flex: 1 } }, el), actionBtn('Set password', async () => { await api(`/users/${rec.id}/reset-password`, { body: { next: pw.value } }); pw.value = ''; toast('Password reset', 'good'); })));
}

export async function profilePage(root) {
  const u = state.user;
  const [cur, curEl] = pwField('Current password', 'current-password'), [next, nextEl] = pwField('New password (min. 8 characters)', 'new-password'), [again, againEl] = pwField('Repeat new password', 'new-password');
  const changePw = async () => {
    [cur, next, again].forEach(i => fieldError(i, ''));
    if (!cur.value) { fieldError(cur, 'Enter your current password'); return cur.focus(); }
    if (next.value.length < 8) { fieldError(next, 'Use at least 8 characters'); return next.focus(); }
    if (next.value !== again.value) { fieldError(again, 'The two passwords do not match'); return again.focus(); }
    try { await api('/password', { body: { current: cur.value, next: next.value } }); } catch (e) { fieldError(cur, e.message); return cur.focus(); }
    [cur, next, again].forEach(i => { i.value = ''; }); toast('Password changed', 'good');
  };
  root.replaceChildren(...page('My profile', null, card(u.name, badge(u.role_label, 'info'), h('div.body', h('div.fields', field('Email', h('input', { value: u.email, disabled: true })), field('Role', h('input', { value: u.role_label, disabled: true }))),
    h('h3', { style: { margin: '18px 0 6px' } }, 'Face recognition login'),
    h('p.muted', u.has_face ? 'Your face is enrolled. You can sign in with the camera; on field devices this also triggers the VPN client.' : 'Enrol your face to sign in with the camera. Only a numeric face signature is stored, never a photo.'),
    actionBtn(u.has_face ? 'Re-enrol my face' : 'Enrol my face', async () => { const d = await captureFace('Enrol face'); await api('/face/enroll', { body: { descriptor: d } }); u.has_face = true; toast('Face enrolled', 'good'); profilePage(root); }),
    h('div.section-title', 'Change password'), h('div.fields', curEl, nextEl, againEl), h('div', { style: { marginTop: '12px' } }, actionBtn('Change password', changePw, 'primary'))))));
}

// ---------- Form extras ----------
export async function documentFile(rec, reload) {
  if (!rec.id) return h('p.muted', { style: { marginTop: '14px' } }, 'Save the document first, then attach the manual file.');
  const input = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt' });
  const upload = async () => {
    const file = input.files[0];
    if (!file) throw new Error('Choose a file first');
    if (file.size > 5e6) throw new Error('File is larger than 5 MB');   // base64 adds a third; stays under the host's post_max_size
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
    await api(`/documents/${rec.id}/upload`, { body: { file_name: file.name, mime: file.type, data } });
    toast('File stored in the document repository', 'good'); reload();
  };
  return h('div.lines', h('h3', 'File in cloud repository'), h('div.row', rec.has_file ? h('a.btn', { href: `/api/documents/${rec.id}/file`, target: '_blank', rel: 'noopener' }, `Open ${rec.file_name}`) : badge('no file yet'),
    can('planning', 'assets') ? [h('div', { style: { maxWidth: '320px' } }, input), actionBtn(rec.has_file ? 'Replace file' : 'Upload', upload)] : null));
}
export async function poApprovals(rec) {
  if (!rec.approvals?.length) return null;
  const roles = state.meta.roles;
  return h('div.lines', h('h3', 'Approval routing'), simpleTable([{ label: 'Step', get: a => rec.approvals.indexOf(a) + 1 }, { label: 'Approver', get: a => roleLabel(a.role) }, { label: 'Decision', get: a => badge(a.status) },
    { label: 'By', get: a => a.by || '' }, { label: 'When', get: a => fmtDT(a.at) }, { label: 'Note', get: a => a.note || '' }], rec.approvals));
}

// ---------- Finance reports ----------
export async function projectCostsPage(root) {
  const [costs, projects] = await Promise.all([rows('project_costs'), rows('projects')]);
  const cats = ['labor', 'material', 'equipment', 'services', 'other'];
  const data = projects.map(p => { const mine = costs.filter(c => c.project_id === p.id); const by = Object.fromEntries(cats.map(k => [k, mine.filter(c => c.category === k).reduce((a, c) => a + Number(c.amount), 0)]));
    return { ...p, by, total: mine.reduce((a, c) => a + Number(c.amount), 0) }; });
  root.replaceChildren(...page('Project Costs', h('a.btn', { href: '#/operations/project_costs' }, 'Cost entries'), card('Accumulated cost by project', null, simpleTable([{ label: 'Project', get: p => `${p.code} · ${p.name}` }, { label: 'Status', get: p => badge(p.status) },
    ...cats.map(k => ({ label: k[0].toUpperCase() + k.slice(1), get: p => fmtNum(p.by[k], 0), num: 1 })), { label: 'Total', get: p => h('strong', fmtNum(p.total, 0)), num: 1 }, { label: 'Budget', get: p => fmtNum(p.budget, 0), num: 1 },
    { label: 'Used', get: p => (p.budget ? badge(`${Math.round(p.total / p.budget * 100)}%`, p.total > p.budget ? 'bad' : 'good') : '') }], data, { empty: 'No projects yet' }))));
}
export async function trialBalancePage(root) {
  const tb = await api('/finance/trial-balance');
  const d = tb.reduce((a, r) => a + r.debit, 0), c = tb.reduce((a, r) => a + r.credit, 0);
  root.replaceChildren(...page('Trial Balance', h('button.btn', { onclick: () => window.print() }, 'Print'), card(null, null, simpleTable([{ label: 'Code', key: 'code' }, { label: 'Account', key: 'name' }, { label: 'Type', key: 'type' },
    { label: 'Debit', get: r => (r.debit ? fmtNum(r.debit) : ''), num: 1 }, { label: 'Credit', get: r => (r.credit ? fmtNum(r.credit) : ''), num: 1 }], [...tb, { code: '', name: 'Total', type: '', debit: d, credit: c }]))));
}

// ---------- On-premise PostgreSQL sync ----------
export async function syncPage(root) {
  const s = await api('/sync/status');
  root.replaceChildren(...page('Data Sync', s.configured ? actionBtn('Sync now', async () => { const r = await api('/sync/run', { body: {} }); toast(`Synchronised ${r.rows} row(s) to the on-premise database`, 'good'); syncPage(root); }, 'primary') : null,
    h('div.stack', card('Databases', null, h('div.body', h('div.fields',
      field('Primary database', h('div', badge(s.primary === 'supabase' ? 'Supabase (cloud)' : 'Local demo file', s.primary === 'supabase' ? 'good' : 'warn'), s.primary === 'supabase' ? null : h('div.muted', 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env to use Supabase.'))),
      field('On-premise PostgreSQL mirror', h('div', badge(s.configured ? 'configured' : 'not configured', s.configured ? 'good' : ''), h('div.muted', s.configured ? (s.interval_min ? `Automatic sync every ${s.interval_min} minutes.` : 'Manual sync only (set SYNC_INTERVAL_MIN for automatic).') : 'Set ONPREM_PG_URL in .env on the server and restart to enable synchronisation.')))))),
    card('Sync history', null, simpleTable([{ label: 'Started', get: l => fmtDT(l.started_at) }, { label: 'Finished', get: l => fmtDT(l.finished_at) }, { label: 'Rows', key: 'rows', num: 1 }, { label: 'Result', get: l => badge(l.status) }, { label: 'Message', key: 'message' }], s.log, { empty: 'No synchronisation has run yet' })))));
}
