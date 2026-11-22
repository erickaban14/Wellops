// Builds dist/htdocs: the folder to upload to InfinityFree's htdocs.   node php/tools/dist.mjs
// Layout: public/* at the root, api/, app/, install.php, config.sample.php, .htaccess files. Local config.php, installed.lock and uploads are never copied.
import { cpSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'dist', 'htdocs');
rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, 'public'), out, { recursive: true });
cpSync(join(root, 'php', 'api'), join(out, 'api'), { recursive: true });
cpSync(join(root, 'php', 'app'), join(out, 'app'), { recursive: true, filter: s => !s.endsWith('installed.lock') });
for (const f of ['install.php', 'convert-omr.php', 'config.sample.php']) copyFileSync(join(root, 'php', f), join(out, f));
copyFileSync(join(root, 'php', 'deploy', 'root.htaccess'), join(out, '.htaccess'));
copyFileSync(join(root, 'php', 'deploy', 'deny.htaccess'), join(out, 'app', '.htaccess'));
mkdirSync(join(out, 'uploads'));
copyFileSync(join(root, 'php', 'deploy', 'deny.htaccess'), join(out, 'uploads', '.htaccess'));

const count = d => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
console.log(`dist/htdocs ready: ${count(out)} files`);
console.log('Next: copy config.sample.php to config.php (fill in the MySQL details), upload everything to htdocs, open /install.php?key=<install_key>, then delete install.php.');
