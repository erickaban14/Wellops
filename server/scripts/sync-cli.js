import '../env.js';
const { runSync } = await import('../sync/pgsync.js');
const log = await runSync('cli');
console.log(`Synced ${log.rows} rows to on-prem PostgreSQL`);
process.exit(0);
