// Demo/offline driver: whole database in data/db.json. Not for production use.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('data');
const file = path.join(dir, 'db.json');
const uploads = path.join(dir, 'uploads');
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }, 150); };
const t = name => (data[name] ||= []);

export default {
  name: 'local',
  async list(table, where) {
    const keys = Object.keys(where);
    return t(table).filter(r => keys.every(k => r[k] === where[k])).map(r => ({ ...r }));
  },
  async insert(table, rows) { t(table).push(...rows.map(r => ({ ...r }))); save(); },
  async update(table, id, patch) {
    const row = t(table).find(r => r.id === id);
    if (!row) throw Object.assign(new Error(`${table} record not found`), { status: 404 });
    Object.assign(row, patch); save();
    return { ...row };
  },
  async remove(table, id) { data[table] = t(table).filter(r => r.id !== id); save(); },
  storage: {
    async put(key, buffer) { fs.mkdirSync(uploads, { recursive: true }); fs.writeFileSync(path.join(uploads, key), buffer); },
    async get(key) { const p = path.join(uploads, path.basename(key)); return fs.existsSync(p) ? { buffer: fs.readFileSync(p) } : null; },
  },
};
