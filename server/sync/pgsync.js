// One-way mirror: primary database (Supabase) -> on-premise PostgreSQL.
// Creates/upgrades tables on the mirror, upserts rows changed since the last successful sync and removes rows deleted upstream.
import pg from 'pg';
import { models } from '../models.js';
import { columnsOf, ddl } from '../schema.js';
import { db } from '../store/index.js';
import { fail, now } from '../util.js';

let running = false;
export const syncConfigured = () => !!process.env.ONPREM_PG_URL;

export async function runSync(trigger = 'manual') {
  if (!syncConfigured()) fail(400, 'ONPREM_PG_URL is not set. Add the on-premise PostgreSQL connection string to .env and restart.');
  if (running) fail(409, 'A sync is already running');
  running = true;
  const started = now();
  const client = new pg.Client({ connectionString: process.env.ONPREM_PG_URL });
  let total = 0;
  try {
    await client.connect();
    const last = (await db.list('sync_log', { status: 'ok' })).map(l => l.started_at).sort().pop();
    for (const table of Object.keys(models)) {
      if (table === 'sync_log') continue;
      await client.query(ddl(table));
      const rows = await db.list(table);
      const cols = columnsOf(table).map(c => c[0]);
      const jsonCols = new Set(Object.entries(models[table].fields).filter(([, f]) => f.type === 'json').map(([k]) => k));
      const changed = last ? rows.filter(r => !r.updated_at || new Date(r.updated_at) >= new Date(last)) : rows;
      const sql = `insert into public."${table}" (${cols.map(c => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
        on conflict (id) do update set ${cols.slice(1).map(c => `"${c}"=excluded."${c}"`).join(',')}`;
      await client.query('begin');
      for (const r of changed) await client.query(sql, cols.map(c => (jsonCols.has(c) && r[c] != null ? JSON.stringify(r[c]) : r[c] ?? null)));
      await client.query(`delete from public."${table}" where not (id = any($1))`, [rows.map(r => r.id)]);
      await client.query('commit');
      total += changed.length;
    }
    return await db.insert('sync_log', { started_at: started, finished_at: now(), target: 'on-prem PostgreSQL', status: 'ok', rows: total, message: `${trigger} sync` });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    await db.insert('sync_log', { started_at: started, finished_at: now(), target: 'on-prem PostgreSQL', status: 'error', rows: total, message: e.message });
    fail(502, `Sync failed: ${e.message}`);
  } finally {
    running = false;
    await client.end().catch(() => {});
  }
}

export function startSyncTimer() {
  const min = Number(process.env.SYNC_INTERVAL_MIN) || 0;
  if (min > 0 && syncConfigured()) setInterval(() => runSync('scheduled').catch(e => console.error('[sync]', e.message)), min * 60000).unref();
}
