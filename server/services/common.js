import { db } from '../store/index.js';
import { num, r2 } from '../util.js';

export async function setting(key, fallback) {
  const row = (await db.list('settings', { key }))[0];
  return row?.value ?? fallback;
}

// Post a balanced journal entry. lines: [accountCode, debit, credit]
export async function journal(date, ref, memo, lines, project_id = null) {
  const accounts = await db.list('accounts');
  const rows = lines.filter(([, d, c]) => num(d) || num(c)).map(([code, debit, credit]) => ({
    entry_date: date, ref, memo, account_id: accounts.find(a => a.code === code)?.id, debit: r2(debit), credit: r2(credit), project_id }));
  if (rows.every(r => r.account_id)) await db.insert('journal_entries', rows);
}

export const notify = (role, title, body, extra = {}) => db.insert('notifications', { role, title, body, kind: 'info', read: false, ...extra });
