const crypto = require('node:crypto');
const { settings } = require('./roleSecurityConfig');
const { validateAccessLevels } = require('./accessLevels');

function enforcementEnabled() {
  const mode = settings().mode;
  if (!['compat', 'strict'].includes(mode)) throw new Error('ROLE_SIGNATURE_ENFORCEMENT must be compat or strict.');
  return mode === 'strict';
}
function accountAllowed(user) {
  if (!user) return false;
  if (user.ROLE_SIGNATURE) return verifyUser(user);
  return !enforcementEnabled();
}
async function userSchema(pool) {
  const result = await pool.request().query("SELECT COL_LENGTH('dbo.USER', 'ROLE_SIGNATURE') AS signatureColumn, COL_LENGTH('dbo.USER', 'ACCESS_LEVELS') AS levelsColumn");
  return { signature: result.recordset[0].signatureColumn != null, levels: result.recordset[0].levelsColumn != null };
}
function optionalSignature(user, schema) {
  if (!schema.signature || !settings().key) {
    if (enforcementEnabled()) throw new Error('Run the user security migration and configure ROLE_SIGNING_KEY first.');
    return null;
  }
  return signUser(user);
}
function signingKey() {
  const key = settings().key;
  if (!key || !/^(?:[a-f0-9]{2}){32,}$/i.test(key)) {
    throw new Error('ROLE_SIGNING_KEY must be an independent random hex key of at least 32 bytes.');
  }
  if (key === process.env.JWT_SECRET) throw new Error('Use a separate role signing key.');
  return Buffer.from(key, 'hex');
}
function rolePayload(user) {
  const roles = validateAccessLevels(user.ACCESS_LEVELS == null
    ? String(user.ACCESS_LEVEL).trim() : String(user.ACCESS_LEVELS).split(',').map(v => v.trim()));
  const primary = String(user.ACCESS_LEVEL).trim();
  if (!roles.includes(Number(primary))) throw new Error('Primary role must be assigned.');
  if (!user.USER_CODE || !user.USERNAME || typeof user.PASSWORD !== 'string') throw new Error('Incomplete user identity.');
  if (![0, 1, false, true].includes(user.ACTIVE)) throw new Error('Invalid active status.');
  return JSON.stringify(['user-access-v1', String(user.ID), String(user.USER_CODE).trim(),
    String(user.USERNAME), user.DEPARTMENT ?? '', primary, roles, Boolean(user.ACTIVE), user.PASSWORD]);
}
function signUser(user) {
  return crypto.createHmac('sha256', signingKey()).update(rolePayload(user)).digest('hex');
}
function verifyUser(user) {
  const key = signingKey(); // Missing configuration must fail closed.
  if (!user || !/^[a-f0-9]{64}$/i.test(user.ROLE_SIGNATURE || '')) return false;
  try {
    const expected = crypto.createHmac('sha256', key).update(rolePayload(user)).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(user.ROLE_SIGNATURE, 'hex'));
  } catch { return false; }
}
function migrationFingerprint(user) {
  return crypto.createHash('sha256').update(rolePayload(user)).update(user.ROLE_SIGNATURE || '').digest('hex');
}
function publicUser(user) {
  const { PASSWORD, ROLE_SIGNATURE, TELECMI_PASSWORD, ...safe } = user;
  return safe;
}
module.exports = { signUser, verifyUser, migrationFingerprint, publicUser, enforcementEnabled, accountAllowed, userSchema, optionalSignature };
