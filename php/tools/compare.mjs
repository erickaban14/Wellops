// Runs identical steps against the Node API and the PHP API (both freshly seeded) and diffs the responses,
// ignoring generated ids and timestamps.   node php/tools/compare.mjs [nodeBase] [phpBase]
const NODE = (process.argv[2] || 'http://127.0.0.1:3001') + '/api', PHP = (process.argv[3] || 'http://127.0.0.1:8080') + '/api';

async function session(base, role) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() || []; if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
    const t = await res.text(); try { return { status: res.status, data: JSON.parse(t) }; } catch { return { status: res.status, data: t.slice(0, 200) }; }
  };
  await call('POST', 'demo-login', { role });
  return call;
}

async function collect(base) {
  const out = {}, admin = await session(base, 'admin');
  out.mps = (await admin('POST', 'planning/mps/generate')).data;
  for (const l of (await admin('GET', 'data/mps_lines')).data.filter(l => l.status === 'draft')) await admin('PUT', `data/mps_lines/${l.id}`, { status: 'firmed' });
  const run = (await admin('POST', 'planning/mrp/run')).data;
  out.mrp = run.result;
  out.mrp_status = run.status;
  out.approve = (await admin('POST', `planning/mrp/${run.id}/approve`)).data.status;
  out.firm = (await admin('POST', `planning/mrp/${run.id}/firm`)).data;
  for (const t of ['projects', 'project_activities', 'project_materials', 'project_manning', 'project_kpis', 'requisitions', 'rfqs', 'training_schedules', 'mps_lines', 'sales_orders'])
    out['t_' + t] = (await admin('GET', `data/${t}`)).data;
  const proj = (await admin('GET', 'data/projects')).data.find(p => p.status === 'active');
  out.overview = (await admin('GET', `operations/projects/${proj.id}/overview`)).data;
  out.compliance = (await admin('GET', 'hr/training/compliance')).data;
  out.timesummary = (await admin('GET', 'hr/timekeeping/summary')).data;
  const start = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  out.availability = (await admin('GET', `planning/availability?start=${start}&end=${end}`)).data;
  out.trial = (await admin('GET', 'finance/trial-balance')).data;
  const roles = Object.keys((await (await fetch(`${base}/public`)).json()).roles);
  out.dash = {};
  for (const r of roles) out.dash[r] = (await (await session(base, r))('GET', 'dashboard')).data;
  return out;
}

// Normalise: drop ids/timestamps/volatile fields, round floats, sort object keys.
const DROP = /(^|_)id$|^id$|created_at|updated_at|^run_date$|^synced_at$|^at$/;
function norm(v, key = '') {
  if (Array.isArray(v)) return v.map(x => norm(x));
  // compliance cells are keyed by course id (differs per database) and Node omits empty fields: compare as sorted lists without nulls
  if (key === 'cells' && v && typeof v === 'object') return Object.values(v).map(c => norm(Object.fromEntries(Object.entries(c).filter(([, x]) => x != null)))).map(x => JSON.stringify(x)).sort().map(x => JSON.parse(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter(k => !DROP.test(k)).map(k => [k, norm(v[k], k)]));
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'string') return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>');
  return v;
}
let diffs = 0;
function diff(a, b, path) {
  if (diffs >= 25) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) { diffs++; console.log(`DIFF ${path}: length node=${a.length} php=${b.length}`); }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`);
    return;
  }
  diffs++; console.log(`DIFF ${path}: node=${JSON.stringify(a)?.slice(0, 120)}  php=${JSON.stringify(b)?.slice(0, 120)}`);
}

const [n, p] = [norm(await collect(NODE)), norm(await collect(PHP))];
const sections = Object.keys(n);
for (const s of sections) { const before = diffs; const cap = diffs; diffs = 0; diff(n[s], p[s], s); const d = diffs; diffs = before + d; console.log(`${d === 0 ? 'same' : 'DIFFERENT'}  ${s}${d ? ` (${d}${d >= 25 ? '+' : ''} diffs)` : ''}`); }
console.log(diffs ? `\n${diffs}+ differences` : '\nNode and PHP responses are identical (ids/timestamps ignored)');
