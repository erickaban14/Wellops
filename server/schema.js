import { models } from './models.js';

const SQL_TYPE = { text: 'text', longtext: 'text', select: 'text', ref: 'text', number: 'numeric', date: 'date', datetime: 'timestamptz', bool: 'boolean', json: 'jsonb' };

export function columnsOf(table) {
  return [['id', 'text primary key'], ['created_at', 'timestamptz default now()'], ['updated_at', 'timestamptz default now()'],
    ...Object.entries(models[table].fields).map(([k, f]) => [k, SQL_TYPE[f.type] || 'text'])];
}

// Idempotent DDL: create table, then add any columns introduced by later versions.
export function ddl(table, { rls = false } = {}) {
  const cols = columnsOf(table);
  let sql = `create table if not exists public."${table}" (\n${cols.map(([k, t]) => `  "${k}" ${t}`).join(',\n')}\n);\n`;
  for (const [k, t] of cols.slice(3)) sql += `alter table public."${table}" add column if not exists "${k}" ${t};\n`;
  sql += `create index if not exists "${table}_updated_at_idx" on public."${table}" (updated_at);\n`;
  // RLS on with no policies: only the Node server (service role key) can read or write.
  if (rls) sql += `alter table public."${table}" enable row level security;\n`;
  return sql;
}

export const fullSchema = opts => Object.keys(models).map(t => ddl(t, opts)).join('\n');
