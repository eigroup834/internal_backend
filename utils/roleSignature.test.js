const test = require('node:test');
const assert = require('node:assert/strict');
const { signUser, verifyUser, migrationFingerprint, publicUser, accountAllowed, optionalSignature } = require('./roleSignature');
process.env.ROLE_SIGNING_KEY = 'ab'.repeat(32);
const original = { ID: 1, USER_CODE: 'TEST', USERNAME: 'test', DEPARTMENT: 'Visitor',
  ACCESS_LEVEL: '3', ACCESS_LEVELS: '3,6', ACTIVE: true, PASSWORD: 'stored-password-hash' };

test('signs existing and multiple roles without changing them', () => {
  for (const user of [original, { ...original, ACCESS_LEVELS: null }]) {
    const signed = { ...user, ROLE_SIGNATURE: signUser(user) };
    assert.equal(verifyUser(signed), true);
  }
});
test('rejects unsigned accounts and copied signatures', () => {
  assert.equal(verifyUser(original), false);
  assert.equal(verifyUser({ ...original, USER_CODE: 'OTHER', ROLE_SIGNATURE: signUser(original) }), false);
});
test('rejects tampering with roles, credentials, identity and status', () => {
  const signed = { ...original, ROLE_SIGNATURE: signUser(original) };
  const changes = { ACCESS_LEVEL: '1', ACCESS_LEVELS: '3,1', PASSWORD: 'replacement', ACTIVE: false,
    USERNAME: 'other', ID: 2, DEPARTMENT: 'Sales' };
  for (const [key, value] of Object.entries(changes)) assert.equal(verifyUser({ ...signed, [key]: value }), false, key);
});
test('rejects invalid roles and incomplete identity', () => {
  for (const ACCESS_LEVELS of ['', '3,bad', '3,8', '6']) assert.throws(() => signUser({ ...original, ACCESS_LEVELS }));
  assert.throws(() => signUser({ ...original, USER_CODE: '' }));
});
test('detects changes after the migration snapshot', () => {
  assert.notEqual(migrationFingerprint(original), migrationFingerprint({ ...original, PASSWORD: 'changed' }));
});
test('strips secrets from API responses', () => {
  const safe = publicUser({ ...original, ROLE_SIGNATURE: signUser(original), TELECMI_PASSWORD: 'secret' });
  assert.equal(safe.PASSWORD, undefined);
  assert.equal(safe.ROLE_SIGNATURE, undefined);
  assert.equal(safe.TELECMI_PASSWORD, undefined);
  assert.equal(safe.USER_CODE, original.USER_CODE);
});
test('fails closed if signing key is missing or reused', () => {
  const key = process.env.ROLE_SIGNING_KEY;
  try {
    delete process.env.ROLE_SIGNING_KEY;
    assert.throws(() => verifyUser(original));
    process.env.ROLE_SIGNING_KEY = process.env.JWT_SECRET = key;
    assert.throws(() => signUser(original));
  } finally { process.env.ROLE_SIGNING_KEY = key; delete process.env.JWT_SECRET; }
});

test('compatibility explicitly allows unsigned users but never invalid signatures', () => {
  process.env.ROLE_SIGNATURE_ENFORCEMENT = 'compat';
  try {
    assert.equal(accountAllowed(original), true);
    assert.equal(accountAllowed({ ...original, ROLE_SIGNATURE: '00'.repeat(32) }), false);
    assert.equal(optionalSignature(original, { signature: false }), null);
  } finally { delete process.env.ROLE_SIGNATURE_ENFORCEMENT; }
});
test('strict mode rejects unsigned accounts and missing schema', () => {
  process.env.ROLE_SIGNATURE_ENFORCEMENT = 'strict';
  try {
    assert.equal(accountAllowed(original), false);
    assert.throws(() => optionalSignature(original, { signature: false }));
  } finally { delete process.env.ROLE_SIGNATURE_ENFORCEMENT; }
});
