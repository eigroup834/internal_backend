const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { signUser } = require('./roleSignature');
process.env.ROLE_SIGNATURE_ENFORCEMENT = 'strict';
process.env.ROLE_SIGNING_KEY = 'cd'.repeat(32);
process.env.JWT_SECRET = 'test-jwt-key-independent-of-role-key';
let record;
require.cache[require.resolve('../db')] = { exports: {
  sql: { VarChar: () => {} }, poolPromise: Promise.resolve({ request() {
    return { input() { return this; }, async query() { return { recordset: record ? [record] : [] }; } };
  } })
} };
const { login } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
async function approved() {
  const row = { ID: 1, USER_CODE: 'TEST', USERNAME: 'test', DEPARTMENT: 'Visitor', ACTIVE: true,
    ACCESS_LEVEL: '3', ACCESS_LEVELS: '3,6', PASSWORD: await bcrypt.hash('existing-password', 4) };
  row.ROLE_SIGNATURE = signUser(row);
  return row;
}
test('migrated password still logs in and exposes both signed roles', async () => {
  record = await approved();
  const res = response();
  await login({ body: { username: 'test', password: 'existing-password' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(jwt.verify(res.body.token, process.env.JWT_SECRET).access_levels, [3, 6]);
  assert.equal(res.body.user.PASSWORD, undefined);
  assert.equal(res.body.user.ROLE_SIGNATURE, undefined);
});
test('unsigned and tampered users cannot log in even with the correct password', async () => {
  const row = await approved();
  for (const changed of [{ ...row, ROLE_SIGNATURE: null }, { ...row, ACCESS_LEVELS: '3,1' }]) {
    record = changed;
    const res = response();
    await login({ body: { username: 'test', password: 'existing-password' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.token, undefined);
  }
});
test('protected requests require a current signed account and invalidate old sessions', async () => {
  record = await approved();
  const claims = { user_code: record.USER_CODE, access_levels: [3, 6], role_signature: record.ROLE_SIGNATURE };
  const token = jwt.sign(claims, process.env.JWT_SECRET);
  let allowed = false;
  await authenticate({ headers: { authorization: `Bearer ${token}` } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
  record.ACCESS_LEVELS = '3';
  record.ROLE_SIGNATURE = signUser(record);
  const res = response();
  await authenticate({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('stale token authorized'));
  assert.equal(res.statusCode, 403);
  const legacy = jwt.sign({ user_code: record.USER_CODE, access_level: 3 }, process.env.JWT_SECRET);
  const old = response();
  await authenticate({ headers: { authorization: `Bearer ${legacy}` } }, old, () => assert.fail('legacy token authorized'));
  assert.equal(old.statusCode, 403);
});

test('compatibility mode allows legacy plaintext login without signatures or key', async () => {
  const key = process.env.ROLE_SIGNING_KEY;
  process.env.ROLE_SIGNATURE_ENFORCEMENT = 'compat';
  delete process.env.ROLE_SIGNING_KEY;
  try {
    record = { ID: 1, USER_CODE: 'TEST', USERNAME: 'test', ACTIVE: true, ACCESS_LEVEL: '3', PASSWORD: 'existing-password' };
    const res = response();
    await login({ body: { username: 'test', password: 'existing-password' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(jwt.verify(res.body.token, process.env.JWT_SECRET).access_levels, [3]);
    const wrong = response();
    await login({ body: { username: 'test', password: 'wrong' } }, wrong);
    assert.equal(wrong.statusCode, 401);
  } finally { process.env.ROLE_SIGNING_KEY = key; process.env.ROLE_SIGNATURE_ENFORCEMENT = 'strict'; }
});
test('legacy JWT keeps working during migration and uses current database roles', async () => {
  process.env.ROLE_SIGNATURE_ENFORCEMENT = 'compat';
  try {
    record = await approved();
    const token = jwt.sign({ user_code: record.USER_CODE, access_level: 3 }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    let allowed = false;
    await authenticate(req, response(), () => { allowed = true; });
    assert.equal(allowed, true);
    assert.deepEqual(req.user.access_levels, [3, 6]);
    record.ACCESS_LEVELS = '3,1';
    const res = response();
    await authenticate(req, res, () => assert.fail('tampered signed record accepted'));
    assert.equal(res.statusCode, 403);
  } finally { process.env.ROLE_SIGNATURE_ENFORCEMENT = 'strict'; }
});
