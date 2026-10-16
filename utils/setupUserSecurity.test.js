const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../scripts/setupUserSecurity'), 'utf8');
function run({ fail, existing, env = {} } = {}) {
  const root = path.dirname(path.dirname(require.resolve('../scripts/setupUserSecurity')));
  const configPath = path.join(root, '.role-security.json');
  const files = new Map(existing ? [[configPath, JSON.stringify(existing)]] : []);
  const steps = [];
  const proc = { pid: 123, execPath: 'node', env };
  const fakeFs = {
    mkdirSync() {}, openSync(file) { files.set(file, 'locked'); return 1; }, closeSync() {},
    existsSync(file) { return files.has(file); },
    writeFileSync(file, data) { files.set(file, data); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); }
  };
  vm.runInNewContext(source, {
    __dirname: path.join(root, 'scripts'), process: proc, console: { log() {}, error() {} },
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return require('node:crypto');
      if (name === 'dotenv') return { config() {} };
      if (name === '../utils/roleSignature') return { signUser() { return 'valid'; } };
      if (name === '../utils/roleSecurityConfig') return { configPath, settings() {
        if (files.has(configPath)) { const saved = JSON.parse(files.get(configPath)); return { key: saved.key, mode: saved.mode }; }
        return { key: env.ROLE_SIGNING_KEY, mode: 'compat' };
      } };
      if (name === 'node:child_process') return { spawnSync(binary, args) {
        steps.push(args[1]);
        return { status: args[1] === fail ? 1 : 0 };
      } };
      throw new Error(name);
    }
  });
  return { code: proc.exitCode || 0, steps, saved: files.has(configPath) ? JSON.parse(files.get(configPath)) : null,
    locked: [...files.keys()].some(name => name.endsWith('.lock')) };
}
test('one command prepares, snapshots, migrates, verifies and then enables protection', () => {
  const result = run();
  assert.equal(result.code, 0);
  assert.deepEqual(result.steps, ['--prepare', '--snapshot', '--apply', '--check']);
  assert.equal(result.saved.mode, 'strict');
  assert.match(result.saved.key, /^[a-f0-9]{64}$/);
  assert.equal(result.locked, false);
});
test('migration or verification failure never newly enables strict protection', () => {
  for (const fail of ['--prepare', '--snapshot', '--apply', '--check']) {
    const result = run({ fail });
    assert.equal(result.code, 1);
    assert.equal(result.saved.mode, 'compat');
    assert.equal(result.locked, false);
  }
});
test('reruns preserve the signing key and existing enforcement', () => {
  const existing = { version: 1, key: 'ab'.repeat(32), mode: 'strict' };
  const result = run({ existing });
  assert.equal(result.code, 0);
  assert.deepEqual(result.saved, existing);
});
test('invalid configured key cannot write a broken configuration', () => {
  const result = run({ env: { ROLE_SIGNING_KEY: 'bad' } });
  assert.equal(result.code, 1);
  assert.equal(result.saved, null);
  assert.equal(result.steps.length, 0);
});
