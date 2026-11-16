// Storage facade. Supabase when configured, otherwise a local JSON file (demo mode).
import crypto from 'node:crypto';
import { models } from '../models.js';
import { fail, now } from '../util.js';

const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const driver = (await import(useSupabase ? './supabase.js' : './local.js')).default;

const listeners = new Set();
const emit = table => listeners.forEach(fn => fn(table));

// Coerce values to the column type so both drivers behave the same ('' -> null for dates/numbers/refs).
function clean(table, row, partial) {
  const m = models[table] || fail(404, `Unknown table ${table}`);
  const out = {};
  for (const [k, f] of Object.entries(m.fields)) {
    if (!(k in row)) { if (!partial && f.type === 'bool') out[k] = false; continue; }
    let v = row[k];
    if (f.type === 'number') v = v === '' || v == null ? null : Number(v);
    else if (f.type === 'bool') v = v === true || v === 'true' || v === 1;
    else if (['date', 'datetime', 'ref'].includes(f.type)) v = v || null;
    else if (f.type === 'json') v = typeof v === 'string' && v ? JSON.parse(v) : v ?? null;
    out[k] = v;
  }
  return out;
}

export const db = {
  mode: driver.name,
  onChange: fn => listeners.add(fn),
  async list(table, where = {}) { models[table] || fail(404, `Unknown table ${table}`); return driver.list(table, where); },
  async get(table, id) { return (await driver.list(table, { id }))[0] || null; },
  async insert(table, rowOrRows) {
    const many = Array.isArray(rowOrRows);
    const ts = now();
    const rows = (many ? rowOrRows : [rowOrRows]).map(r => ({ id: r.id || crypto.randomUUID(), created_at: ts, updated_at: ts, ...clean(table, r) }));
    if (rows.length) { await driver.insert(table, rows); emit(table); }
    return many ? rows : rows[0];
  },
  async update(table, id, patch) {
    const row = await driver.update(table, id, { ...clean(table, patch, true), updated_at: now() });
    emit(table);
    return row;
  },
  async remove(table, id) { await driver.remove(table, id); emit(table); },
  // Next document number, e.g. PO-0007
  async nextNo(table, field, prefix) {
    const rows = await driver.list(table, {});
    const max = rows.reduce((a, r) => Math.max(a, parseInt(String(r[field] || '').replace(/\D/g, '')) || 0), 0);
    return prefix + String(max + 1).padStart(4, '0');
  },
  storage: driver.storage,
};
