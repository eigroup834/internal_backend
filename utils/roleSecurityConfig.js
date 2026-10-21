const fs = require('node:fs');
const path = require('node:path');
const configPath = path.join(__dirname, '..', '.role-security.json');
function settings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.version !== 1 || !['disabled', 'compat', 'strict'].includes(saved.mode)
      || !/^(?:[a-f0-9]{2}){32,}$/i.test(saved.key || '')) throw new Error('Invalid role security configuration.');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (saved.key && process.env.ROLE_SIGNING_KEY && saved.key !== process.env.ROLE_SIGNING_KEY) {
    throw new Error('Role signing environment key differs from the saved security key.');
  }
  return { key: saved.key || process.env.ROLE_SIGNING_KEY,
    mode: process.env.ROLE_SIGNATURE_ENFORCEMENT || saved.mode || 'disabled' };
}
module.exports = { settings, configPath };
