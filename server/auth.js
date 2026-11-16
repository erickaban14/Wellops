import crypto from 'node:crypto';
import fs from 'node:fs';
import { ROLES } from './roles.js';
import { db } from './store/index.js';
import { fail } from './util.js';

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = 'data/.session-secret';
  if (!fs.existsSync(f)) { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(32).toString('hex')); }
  return fs.readFileSync(f, 'utf8');
}
const SECRET = secret();
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

export const hashPassword = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startSession(res, user) {
  const body = `${user.id}.${Date.now() + 12 * 3600e3}`;
  res.setHeader('Set-Cookie', `sid=${body}.${sign(body)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
}
export const endSession = res => res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');

export async function currentUser(req) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sid) return null;
  const i = sid.lastIndexOf('.');
  const body = sid.slice(0, i);
  const [id, exp] = body.split('.');
  if (sign(body) !== sid.slice(i + 1) || Number(exp) < Date.now()) return null;
  const user = await db.get('users', id);
  return user && user.active !== false ? user : null;
}

export const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, employee_id: u.employee_id, has_face: !!u.face_descriptor,
  role_label: ROLES[u.role]?.label, modules: ROLES[u.role]?.modules || [] });

export const requireAuth = async (req, res, next) => {
  req.user = await currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  req.modules = ROLES[req.user.role]?.modules || [];
  next();
};
export const can = (req, ...mods) => req.user.role === 'admin' || mods.some(m => req.modules.includes(m));
export const need = (...mods) => (req, res, next) => (can(req, ...mods) ? next() : fail(403, 'Your role does not have access to this function'));

// Face login: compare 128-d descriptors (euclidean distance, face-api.js convention, match < 0.5).
export async function matchFace(descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) fail(400, 'Invalid face descriptor');
  let best = null;
  for (const u of await db.list('users')) {
    if (!Array.isArray(u.face_descriptor) || u.active === false) continue;
    const d = Math.sqrt(u.face_descriptor.reduce((a, v, i) => a + (v - descriptor[i]) ** 2, 0));
    if (d < 0.5 && (!best || d < best.d)) best = { u, d };
  }
  return best?.u || null;
}
