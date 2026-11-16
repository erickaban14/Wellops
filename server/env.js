// Loaded first so every other module sees .env values.
import fs from 'node:fs';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
