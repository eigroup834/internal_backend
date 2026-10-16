const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { migrationFingerprint, verifyUser } = require('./roleSignature');
process.env.ROLE_SIGNING_KEY = 'ef'.repeat(32);
const source = fs.readFileSync(require.resolve('../scripts/migrateSignedUsers'), 'utf8');
const original = { ID: 1, USER_CODE: 'TEST', USERNAME: 'test', DEPARTMENT: 'Visitor', ACTIVE: true,
  ACCESS_LEVEL: '3', ACCESS_LEVELS: '3,6', PASSWORD: 'original-password', ROLE_SIGNATURE: null };
function manifest(row) { return { version: 1, users: [{ userCode: row.USER_CODE, username: row.USERNAME,
  primaryRole: row.ACCESS_LEVEL, roles: row.ACCESS_LEVELS, active: row.ACTIVE, fingerprint: migrationFingerprint(row) }] }; }
async function run(mode, rows, review = manifest(original)) {
  const state = { writes: [], committed: false, rolledBack: false, exitCode: 0, snapshot: null };
  class Transaction { async begin() {} async commit() { state.committed = true; } async rollback() { state.rolledBack = true; } }
  class Request {
    constructor() { this.params = {}; }
    input(key, type, value) { this.params[key] = value; return this; }
    async batch() { state.prepared = true; }
    async query(sql) {
      if (sql.startsWith('UPDATE')) { state.writes.push(this.params); return { rowsAffected: [1] }; }
      if (sql.includes('COL_LENGTH')) return { recordset: [{ signatureColumn: mode === '--snapshot' ? null : 64, levelsColumn: 50 }] };
      return { recordset: structuredClone(this.params.code ? rows.filter(r => r.USER_CODE === this.params.code) : rows) };
    }
  }
  const fakeDb = { sql: { Transaction, Request, VarChar: () => {}, ISOLATION_LEVEL: { SERIALIZABLE: 4 } },
    poolPromise: Promise.resolve({ request: () => new Request(), close() {} }) };
  const proc = { argv: ['node', 'migration', mode, 'review.json'] };
  await vm.runInNewContext(source, {
    require(name) {
      if (name === '../db') return fakeDb;
      if (name === '../utils/roleSignature') return require('./roleSignature');
      if (name === 'node:path') return require('node:path');
      if (name === 'node:fs') return { mkdirSync() {}, readFileSync: () => JSON.stringify(review), writeFileSync(file, data) { state.snapshot = JSON.parse(data); } };
      if (name === 'bcrypt') return require('bcrypt');
      throw new Error(name);
    }, process: proc, console: { log() {}, error(message) { state.error = message; } }, Buffer
  });
  state.exitCode = proc.exitCode || 0;
  return state;
}
test('snapshot is read-only and excludes passwords and signatures', async () => {
  const result = await run('--snapshot', [original]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.writes.length, 0);
  assert.equal(result.snapshot.users[0].roles, '3,6');
  assert.equal(JSON.stringify(result.snapshot).includes(original.PASSWORD), false);
});
test('apply preserves roles and password usability while signing', async () => {
  const result = await run('--apply', [original]);
  assert.equal(result.exitCode, 0, result.error);
  assert.equal(result.committed, true);
  const saved = result.writes[0];
  assert.equal(await require('bcrypt').compare(original.PASSWORD, saved.password), true);
  assert.equal(verifyUser({ ...original, PASSWORD: saved.password, ROLE_SIGNATURE: saved.signature }), true);
});
test('changed accounts, unreviewed accounts and edited review roles are skipped', async () => {
  for (const [rows, review] of [
    [[{ ...original, ACCESS_LEVELS: '3,1' }], manifest(original)],
    [[{ ...original, USER_CODE: 'OTHER' }], manifest(original)],
    [[original], { version: 1, users: [{ ...manifest(original).users[0], roles: '1' }] }]
  ]) {
    const result = await run('--apply', rows, review);
    assert.equal(result.exitCode, 1);
    assert.equal(result.writes.length, 0);
    assert.equal(result.committed, false);
  }
});

test('prepare changes schema only without updating accounts', async () => {
  const result = await run('--prepare', [original]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.prepared, true);
  assert.equal(result.writes.length, 0);
});
test('valid reviewed users migrate even when a new unreviewed account appears', async () => {
  const result = await run('--apply', [original, { ...original, USER_CODE: 'NEW' }]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes.length, 1);
  assert.equal(result.committed, true);
});
test('readiness check rejects active unsigned accounts without writing', async () => {
  const result = await run('--check', [original]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes.length, 0);
});
