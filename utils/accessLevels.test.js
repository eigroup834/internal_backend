const test = require('node:test');
const assert = require('node:assert/strict');
const { getAccessLevels, hasAccessLevel, validateAccessLevels } = require('./accessLevels');
const requireLevel = require('../middleware/requireLevel');

test('legacy tokens and nullable database roles remain supported', () => {
  assert.deepEqual(getAccessLevels({ access_level: '3' }), [3]);
  assert.deepEqual(getAccessLevels({ ACCESS_LEVEL: '3', ACCESS_LEVELS: null }), [3]);
});
test('additional roles authorize only assigned levels', () => {
  const user = { access_level: '3', access_levels: [3, 6] };
  assert.equal(hasAccessLevel(user, [5, 6]), true);
  assert.equal(hasAccessLevel(user, [2, 5]), false);
  assert.deepEqual(getAccessLevels({ ACCESS_LEVELS: '3,5,6' }), [3, 5, 6]);
});
test('explicit collections override the primary role', () => {
  assert.equal(hasAccessLevel({ access_level: 1, access_levels: [6] }, [1]), false);
  assert.equal(hasAccessLevel({ access_level: 1, access_levels: [] }, [1]), false);
});
test('validates role assignments before database writes', () => {
  assert.deepEqual(validateAccessLevels(['3', 6, '3']), [3, 6]);
  for (const roles of [[], [0], [8], ['bad'], [true], ['3,6'], null, undefined]) {
    assert.throws(() => validateAccessLevels(roles));
  }
});
test('middleware accepts any assigned level and preserves array arguments', () => {
  let called = false;
  requireLevel([2, 5, 6])({ user: { access_level: 3, access_levels: [3, 6] } }, {}, () => { called = true; });
  assert.equal(called, true);
});
test('middleware rejects missing and unrelated roles with 403', () => {
  for (const user of [undefined, {}, { access_levels: [3, 6] }, { access_levels: [true, 0, 8] }]) {
    let status;
    let body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; } };
    requireLevel(1, 2)({ user }, res, () => assert.fail('unauthorized request passed'));
    assert.equal(status, 403);
    assert.match(body.error, /permission/);
  }
});
