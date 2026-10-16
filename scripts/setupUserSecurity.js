// One-time command: node scripts/setupUserSecurity.js
// All accounts currently in USER are treated as the approved initial baseline.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const { settings, configPath } = require('../utils/roleSecurityConfig');
const { signUser } = require('../utils/roleSignature');
const local = path.join(root, '.local');
const lock = path.join(local, 'user-security-setup.lock');
function save(config) {
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function step(args) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'migrateSignedUsers.js'), ...args], {
    cwd: root, env: process.env, stdio: 'inherit'
  });
  if (child.error || child.status !== 0) throw new Error(`Step ${args[0]} did not complete. Fix the reported issue and rerun this same command.`);
}
function main() {
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') throw new Error('Another setup may be running. Check it before removing .local/user-security-setup.lock.'); throw err; }
  try {
    const current = settings();
    const config = { version: 1, key: current.key || crypto.randomBytes(32).toString('hex'),
      mode: fs.existsSync(configPath) ? current.mode : 'compat' };
    if (!/^(?:[a-f0-9]{2}){32,}$/i.test(config.key) || config.key === process.env.JWT_SECRET) {
      throw new Error('Signing key must be independent random hex of at least 32 bytes.');
    }
    // Save the same secret for the running backend and every migration subprocess.
    // The backend reads this file dynamically; no additional environment edits are needed.
    save(config);
    signUser({ ID: 0, USER_CODE: 'check', USERNAME: 'check', DEPARTMENT: '', PASSWORD: 'check',
      ACTIVE: false, ACCESS_LEVEL: '1', ACCESS_LEVELS: null });
    step(['--prepare']);
    const snapshot = path.join(local, `users-baseline-${Date.now()}.json`);
    step(['--snapshot', snapshot]);
    step(['--apply', snapshot]);
    step(['--check']);
    save({ ...config, mode: 'strict' });
    console.log('DONE: user table updated, existing accounts migrated, protection enabled. Users can sign in with the same passwords.');
    console.log('Existing sessions must sign in again. Keep .role-security.json private and back it up securely; do not delete it during deployments.');
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
try { main(); } catch (err) {
  console.error(`Setup stopped: ${err.message}`);
  console.error('Protection was not newly enabled. Existing completed account migrations are safe to rerun.');
  process.exitCode = 1;
}
