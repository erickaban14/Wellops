// Supabase driver. The Node server is the only client and uses the service-role key (tables have RLS on, no policies).
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'manuals';
const check = (table, { data, error }) => {
  if (error) throw Object.assign(new Error(`${table}: ${error.message}`), { status: 500 });
  return data;
};

export default {
  name: 'supabase',
  async list(table, where) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const page = check(table, await sb.from(table).select('*').match(where).order('created_at').order('id').range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
  async insert(table, rows) { for (let i = 0; i < rows.length; i += 500) check(table, await sb.from(table).insert(rows.slice(i, i + 500))); },
  async update(table, id, patch) {
    const rows = check(table, await sb.from(table).update(patch).eq('id', id).select());
    if (!rows.length) throw Object.assign(new Error(`${table} record not found`), { status: 404 });
    return rows[0];
  },
  async remove(table, id) { check(table, await sb.from(table).delete().eq('id', id)); },
  storage: {
    async put(key, buffer, mime) { check('storage', await sb.storage.from(bucket).upload(key, buffer, { contentType: mime, upsert: true })); },
    async get(key) { const d = check('storage', await sb.storage.from(bucket).createSignedUrl(key, 300)); return { url: d.signedUrl }; },
  },
};
