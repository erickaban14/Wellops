import './env.js';
import express from 'express';
import path from 'node:path';
import { can, checkPassword, endSession, hashPassword, matchFace, need, publicUser, requireAuth, startSession } from './auth.js';
import { models } from './models.js';
import { ROLES } from './roles.js';
import { seedIfEmpty } from './seed.js';
import { db } from './store/index.js';
import { fail, now, today } from './util.js';
import { dashboard } from './services/dashboard.js';
import * as planning from './services/planning.js';
import * as ops from './services/operations.js';
import * as hr from './services/hr.js';
import * as proc from './services/procurement.js';
import * as inv from './services/inventory.js';
import { runSync, startSyncTimer, syncConfigured } from './sync/pgsync.js';

const DEMO_LOGIN = String(process.env.DEMO_LOGIN ?? 'true') === 'true';
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.resolve('public'), { setHeaders: (res, p) => { if (/sw\.js$|\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
const api = express.Router();
app.use('/api', api);
const boot = { ready: false, error: '' };
api.use((req, res, next) => {
  if (boot.ready || req.path === '/public') return next();
  res.status(503).json({ error: boot.error || 'The database is being prepared (first start). Try again in a minute.' });
});
const h = fn => (req, res, next) => Promise.resolve(fn(req, res)).then(out => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);

// ---------- Auth ----------
const meta = { models, roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, group: r.group }])) };
api.get('/public', h(async () => ({ demo_login: DEMO_LOGIN, mode: db.mode, ready: boot.ready, error: boot.error, roles: DEMO_LOGIN ? meta.roles : {} })));
api.post('/login', h(async (req, res) => {
  const user = (await db.list('users')).find(u => u.email?.toLowerCase() === String(req.body.email || '').toLowerCase());
  if (!user || user.active === false || !checkPassword(req.body.password, user.password_hash)) fail(401, 'Wrong email or password');
  startSession(res, user);
  return publicUser(user);
}));
api.post('/demo-login', h(async (req, res) => {
  if (!DEMO_LOGIN) fail(403, 'Demo login is disabled');
  const user = (await db.list('users', { role: req.body.role }))[0] || fail(404, 'No user with that role');
  startSession(res, user);
  return publicUser(user);
}));
api.post('/face/login', h(async (req, res) => {
  const user = await matchFace(req.body.descriptor) || fail(401, 'Face not recognised. Use email and password, then enrol your face in your profile.');
  startSession(res, user);
  const vpn = (await db.list('settings', { key: 'vpn_connect_url' }))[0]?.value || process.env.VPN_CONNECT_URL || '';
  return { ...publicUser(user), vpn_connect_url: vpn };
}));
api.post('/logout', (req, res) => { endSession(res); res.json({ ok: true }); });

api.use(requireAuth);
api.get('/me', h(async req => ({ user: publicUser(req.user), meta, mode: db.mode, sync_configured: syncConfigured(),
  company: (await db.list('settings', { key: 'company_name' }))[0]?.value || 'ProStars ERP', currency: (await db.list('settings', { key: 'currency' }))[0]?.value || 'USD' })));
api.post('/face/enroll', h(async req => {
  if (!Array.isArray(req.body.descriptor) || req.body.descriptor.length !== 128) fail(400, 'Invalid face descriptor');
  await db.update('users', req.user.id, { face_descriptor: req.body.descriptor });
  return { ok: true };
}));
api.get('/dashboard', h(req => dashboard(req.user)));

// ---------- Password & notifications ----------
const strong = pw => (String(pw || '').length >= 8 ? pw : fail(400, 'Password must be at least 8 characters'));
api.post('/password', h(async req => {
  if (!checkPassword(req.body.current, req.user.password_hash)) fail(400, 'Current password is wrong');
  await db.update('users', req.user.id, { password_hash: hashPassword(strong(req.body.next)) });
  return { ok: true };
}));
api.post('/users/:id/reset-password', h(async req => {       // administrator sets a temporary password
  if (req.user.role !== 'admin') fail(403, 'Only an administrator can reset passwords');
  await db.update('users', req.params.id, { password_hash: hashPassword(strong(req.body.next)) });
  return { ok: true };
}));
const myNotes = async user => (await db.list('notifications')).filter(n => n.role === user.role || n.user_id === user.id).reverse();
api.get('/notifications', h(async req => { const all = await myNotes(req.user); return { unread: all.filter(n => !n.read).length, items: all.slice(0, 30) }; }));
api.post('/notifications/read', h(async req => { for (const n of (await myNotes(req.user)).filter(n => !n.read)) await db.update('notifications', n.id, { read: true }); return { ok: true }; }));

// ---------- Live updates (server-sent events) ----------
const streams = new Set();
api.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }).flushHeaders();
  res.write('retry: 5000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
});
let pending = new Set(), flush;
db.onChange(table => {
  pending.add(table);
  flush ||= setTimeout(() => { const msg = `data: ${JSON.stringify([...pending])}\n\n`; streams.forEach(s => s.write(msg)); pending = new Set(); flush = null; }, 400);
});
setInterval(() => streams.forEach(s => s.write(': ping\n\n')), 25000).unref();

// ---------- Generic data API (driven by models.js) ----------
const model = req => models[req.params.table] || fail(404, 'Unknown table');
const strip = (m, row) => { if (row) for (const [k, f] of Object.entries(m.fields)) if (f.hidden && k !== 'client_id' && k !== 'storage_path') delete row[k]; if (row && 'storage_path' in row) { row.has_file = !!row.storage_path; delete row.storage_path; } return row; };
const canRead = (req, m) => !m.private && m.name !== 'users' || can(req, 'hr', 'finance', 'settings');
const canWrite = (req, m) => can(req, ...m.modules) && (m.name !== 'users' || req.user.role === 'admin');
const ownOnly = (req, m) => m.private && !can(req, 'hr', 'finance');

api.get('/data/:table', h(async req => {
  const m = model(req);
  const where = Object.fromEntries(Object.entries(req.query).filter(([k]) => k in m.fields));
  let rows = await db.list(m.name, where);
  if (m.name === 'payslips' && ownOnly(req, m)) rows = rows.filter(r => r.employee_id === req.user.employee_id);
  else if (!canRead(req, m)) fail(403, 'No access');
  return rows.map(r => strip(m, r));
}));
api.get('/data/:table/:id', h(async req => {
  const m = model(req);
  if (!canRead(req, m)) fail(403, 'No access');
  return strip(m, await db.get(m.name, req.params.id) || fail(404, 'Record not found'));
}));
const prepare = async (m, body, existing) => {
  for (const [k, f] of Object.entries(m.fields)) {
    if (f.hidden || (f.ro && existing)) delete body[k];
    if (f.req && !existing && !body[k]) fail(400, `${f.label} is required`);
    if (f.auto && !existing && !body[k]) body[k] = await db.nextNo(m.name, k, f.auto);
  }
  if (m.name === 'purchase_orders' && body.lines) body.total = proc.poTotal(body.lines);
  if (m.name === 'purchase_orders' && !existing) Object.assign(body, { status: 'draft', approvals: [], current_approver: '' });
  if (m.name === 'purchase_orders' && existing && !['draft', 'rejected'].includes(existing.status)) fail(400, `A PO that is ${existing.status} cannot be edited`);
  if (m.name === 'leaves' && !existing) body.status ||= 'requested';
  return body;
};
api.post('/data/:table', h(async req => {
  const m = model(req);
  if (!canWrite(req, m)) fail(403, `Your role cannot create ${m.label}`);
  if (m.name === 'leaves' && !can(req, 'hr')) Object.assign(req.body, { employee_id: req.user.employee_id, status: 'requested' });
  const body = await prepare(m, req.body);
  if (m.name === 'users') body.password_hash = hashPassword(req.body.password || process.env.SEED_PASSWORD || 'ChangeMe-2026');
  return strip(m, await db.insert(m.name, body));
}));
api.put('/data/:table/:id', h(async req => {
  const m = model(req);
  if (!canWrite(req, m)) fail(403, `Your role cannot edit ${m.label}`);
  const existing = await db.get(m.name, req.params.id) || fail(404, 'Record not found');
  if (m.name === 'leaves' && !can(req, 'hr') && (existing.employee_id !== req.user.employee_id || existing.status !== 'requested')) fail(403, 'You can only change your own pending requests');
  return strip(m, await db.update(m.name, req.params.id, await prepare(m, req.body, existing)));
}));
api.delete('/data/:table/:id', h(async req => {
  const m = model(req);
  if (!canWrite(req, m)) fail(403, `Your role cannot delete ${m.label}`);
  if (m.name === 'payroll_runs') for (const s of await db.list('payslips', { run_id: req.params.id })) await db.remove('payslips', s.id);
  await db.remove(m.name, req.params.id);
  return { ok: true };
}));

// ---------- Planning ----------
api.post('/planning/select-machine', h(req => planning.selectMachine(req.body)));
api.post('/planning/mps/generate', need('planning'), h(() => planning.generateMps()));
api.get('/planning/availability', h(req => planning.availability(req.query.start || today(), req.query.end || today())));
api.post('/planning/mrp/run', need('planning'), h(req => planning.runMrp(req.user)));
api.post('/planning/mrp/:id/approve', need('planning'), h(req => planning.approveMrp(req.params.id, req.user)));
api.post('/planning/mrp/:id/firm', need('planning'), h(req => planning.firmMrp(req.params.id, req.user)));

// ---------- Operations ----------
api.post('/operations/tickets', need('operations'), h(req => ops.saveTicket(req.body, req.user)));
api.post('/operations/tickets/sync', need('operations'), h(async req => {
  const results = [];
  for (const t of req.body.tickets || []) {
    try { const saved = await ops.saveTicket({ ...t, entry_mode: 'offline' }, req.user); results.push({ client_id: t.client_id, ok: true, ticket_no: saved.ticket_no }); }
    catch (e) { results.push({ client_id: t.client_id, ok: false, error: e.message }); }
  }
  return { results };
}));
api.post('/operations/tickets/:id/approve', need('operations'), h(req => ops.approveTicket(req.params.id, req.user)));
api.get('/operations/projects/:id/overview', h(req => ops.overview(req.params.id)));
api.post('/operations/alerts/:id/decide', h(req => ops.decideAlert(req.params.id, !!req.body.approve, req.user, req.body.note)));

// ---------- HR ----------
api.get('/hr/training/compliance', h(() => hr.compliance()));
api.post('/hr/training/generate', need('hr', 'planning'), h(req => hr.generateTraining(req.body.run_id)));
api.post('/hr/timekeeping/consolidate', need('hr'), h(() => hr.consolidate()));
api.get('/hr/timekeeping/summary', h(req => hr.timeSummary(req.query.from, req.query.to)));
api.post('/hr/payroll/run', need('hr'), h(req => hr.runPayroll(req.body)));
api.post('/hr/payroll/:id/approve', need('hr', 'finance'), h(req => hr.approvePayroll(req.params.id)));

// ---------- Procurement ----------
api.post('/procurement/rfq/generate', need('procurement', 'planning'), h(req => proc.generateRfqs(req.body.run_id)));
api.post('/procurement/rfq/:id/convert', need('procurement'), h(req => proc.rfqToPo(req.params.id)));
api.post('/procurement/po/:id/submit', need('procurement'), h(req => proc.submitPo(req.params.id)));
api.post('/procurement/po/:id/decide', h(req => proc.decidePo(req.params.id, !!req.body.approve, req.body.note, req.user)));

// ---------- Inventory ----------
api.post('/inventory/receive', need('inventory'), h(req => inv.receive(req.body, req.user)));
api.post('/inventory/qa', need('inventory'), h(req => inv.qa(req.body, req.user)));
api.post('/inventory/issue', need('inventory'), h(req => inv.issue(req.body, req.user)));
api.post('/inventory/return', need('inventory'), h(req => inv.returnStock(req.body, req.user)));
api.post('/inventory/adjust', need('inventory'), h(req => inv.adjust(req.body, req.user)));
api.post('/inventory/counts/start', need('inventory'), h(req => inv.startCount(req.body)));
api.put('/inventory/counts/:id', need('inventory'), h(async req => {
  const c = await db.get('stock_counts', req.params.id) || fail(404, 'Count not found');
  if (c.status === 'posted') fail(400, 'Count already posted');
  return db.update('stock_counts', c.id, { lines: req.body.lines });
}));
api.post('/inventory/counts/:id/post', need('inventory'), h(req => inv.postCount(req.params.id, req.user)));

// ---------- Finance ----------
api.post('/finance/invoices/:id/post', need('finance'), h(req => inv.postInvoice(req.params.id)));
api.post('/finance/:table/:id/pay', need('finance'), h(req => (['invoices', 'bills'].includes(req.params.table) ? inv.pay(req.params.table, req.params.id) : fail(404, 'Unknown document'))));
api.get('/finance/trial-balance', need('finance'), h(() => inv.trialBalance()));

// ---------- Documents (cloud repository: Supabase Storage, or data/uploads in demo mode) ----------
api.post('/documents/:id/upload', need('planning', 'assets'), h(async req => {
  const doc = await db.get('documents', req.params.id) || fail(404, 'Document not found');
  const { file_name, mime, data } = req.body;
  if (!file_name || !data) fail(400, 'No file received');
  const key = `${doc.id}-${String(file_name).replace(/[^\w.\-]+/g, '_')}`;
  await db.storage.put(key, Buffer.from(data, 'base64'), mime || 'application/octet-stream');
  await db.update('documents', doc.id, { file_name, mime, storage_path: key });
  return { ok: true };
}));
api.get('/documents/:id/file', h(async (req, res) => {
  const doc = await db.get('documents', req.params.id);
  const f = doc?.storage_path && await db.storage.get(doc.storage_path);
  if (!f) fail(404, 'No file uploaded for this document');
  if (f.url) return void res.redirect(f.url);
  res.set({ 'Content-Type': doc.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(doc.file_name)}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' }).send(f.buffer);
}));

// ---------- On-prem sync ----------
api.get('/sync/status', need('settings'), h(async () => ({ configured: syncConfigured(), primary: db.mode, interval_min: Number(process.env.SYNC_INTERVAL_MIN) || 0, log: (await db.list('sync_log')).reverse().slice(0, 15) })));
api.post('/sync/run', need('settings'), h(() => runSync('manual')));

api.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.resolve('public/index.html')));

// Listen first so the host sees the service as up, then prepare the database.
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`ProStars ERP running on http://localhost:${port}  [database: ${db.mode}${syncConfigured() ? ', on-prem sync enabled' : ''}] ${now()}`));
async function prepareDb() {
  try {
    await seedIfEmpty();
    boot.ready = true; boot.error = '';
    startSyncTimer();
    console.log('[startup] Database ready.');
  } catch (e) {
    boot.error = db.mode === 'supabase' && /does not exist|schema cache|relation|Could not find the table/i.test(e.message)
      ? 'Supabase is connected but the tables are missing. Run supabase/schema.sql in the Supabase SQL editor; the server retries automatically.'
      : `Database start-up failed: ${e.message}`;
    console.error('[startup]', boot.error);
    setTimeout(prepareDb, 30000);       // retry, e.g. after the schema has been applied
  }
}
prepareDb();
