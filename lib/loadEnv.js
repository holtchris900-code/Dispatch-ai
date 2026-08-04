// Minimal .env file loader (avoids depending on the `dotenv` npm package).
// Reads KEY=VALUE lines from a .env file in the project root and sets
// process.env accordingly, without overwriting variables already set by
// the hosting platform (Vercel/Render/etc. inject env vars directly, so
// this is mainly for local development).

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const contents = fs.readFileSync(envPath, 'utf-8');
  contents.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

module.exports = loadEnv;
