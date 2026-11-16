export const today = () => new Date().toISOString().slice(0, 10);
export const now = () => new Date().toISOString();
export const addDays = (d, n) => {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(String(b).slice(0, 10)) - new Date(String(a).slice(0, 10))) / 864e5);
export const overlap = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
export const num = v => Number(v) || 0;
export const r2 = v => Math.round(num(v) * 100) / 100;
export const byId = rows => Object.fromEntries(rows.map(r => [r.id, r]));
export const sum = (rows, f) => rows.reduce((a, r) => a + num(typeof f === 'function' ? f(r) : r[f]), 0);
export const groupBy = (rows, f) => rows.reduce((a, r) => { const k = typeof f === 'function' ? f(r) : r[f]; (a[k] ||= []).push(r); return a; }, {});
export const pad = (n, w = 4) => String(n).padStart(w, '0');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
