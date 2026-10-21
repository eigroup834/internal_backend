const bcrypt = require('bcrypt');
const { accountAllowed, enforcementEnabled, publicUser } = require('../utils/roleSignature');
const { getAccessLevels } = require('../utils/accessLevels');
const { poolPromise, sql } = require('../db');
const jwt = require('jsonwebtoken');
const { TABLES } = require('../helper');

function getTokenExpiryInSeconds() {
  const now = new Date();
  const nowIST = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const expiryIST = new Date(nowIST);
  expiryIST.setHours(20, 0, 0, 0);
  if (nowIST >= expiryIST) {
    expiryIST.setDate(expiryIST.getDate() + 1);
  }
  return Math.floor((expiryIST - nowIST) / 1000);
}

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input('username', sql.VarChar, username)
      .query(`
        SELECT * FROM dbo.[${TABLES.USER}]
        WHERE USERNAME = @username
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(401).json({ message: 'Username does not exist' });
    }

    if (!accountAllowed(user)) {
      return res.status(403).json({ message: 'Account access verification failed. Please contact an administrator.' });
    }
    const hashed = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.PASSWORD || '');
    const isMatch = typeof password === 'string' && (hashed
      ? await bcrypt.compare(password, user.PASSWORD)
      : !enforcementEnabled() && (require('../utils/roleSecurityConfig').settings().mode === 'disabled' || !user.ROLE_SIGNATURE) && password === user.PASSWORD);
    if (!isMatch) {
      return res.status(401).json({ message: 'Incorrect password' });
    }

    if (!user.ACTIVE) {
      return res.status(403).json({ message: 'User account is inactive. Please contact admin.' });
    }

    const expiresIn = getTokenExpiryInSeconds();

    const token = jwt.sign(
      {
        id: user.ID,
        username: user.USERNAME,
        user_code: user.USER_CODE,
        access_level: user.ACCESS_LEVEL,
        access_levels: getAccessLevels(user),
        department: user.DEPARTMENT,
        role_signature: user.ROLE_SIGNATURE,
      },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    const userData = publicUser(user);

    res.json({
      message: 'Login successful',
      token,
      user: userData
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server/network error. Please try again later.' });
  }
};
