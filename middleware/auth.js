const { settings } = require('../utils/roleSecurityConfig');
const jwt = require('jsonwebtoken');
const { poolPromise, sql } = require('../db');
const { accountAllowed, enforcementEnabled } = require('../utils/roleSignature');

async function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(403).json({ message: 'Invalid token' }); }
  try {
    const pool = await poolPromise;
    const result = await pool.request().input('code', sql.VarChar(50), user.user_code)
      .query(`SELECT * FROM dbo.[USER] WHERE USER_CODE = @code`);
    const record = result.recordset[0];
    if (!record || !accountAllowed(record) || !record.ACTIVE ||
      (settings().mode !== 'disabled' && (enforcementEnabled() || user.role_signature) && user.role_signature !== record.ROLE_SIGNATURE)) {
      return res.status(403).json({ message: 'Invalid token: account permissions changed or could not be verified. Sign in again.' });
    }
    req.user = { ...user, id: record.ID, username: record.USERNAME, user_code: record.USER_CODE,
      department: record.DEPARTMENT, access_level: record.ACCESS_LEVEL,
      access_levels: require('../utils/accessLevels').getAccessLevels(record) };
    next();
  } catch (err) {
    console.error('Account verification failed:', err.message);
    return res.status(503).json({ message: 'Account verification is temporarily unavailable.' });
  }
}
module.exports = authenticateToken;
