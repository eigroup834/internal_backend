const { poolPromise, sql } = require('../db');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('username', sql.VarChar, username)
      .query(`SELECT * FROM dbo.DEVP_USER WHERE USERNAME = @username AND ACTIVE = 1`);

    const user = result.recordset[0];
    if (!user) {
      return res.status(401).json({ message: 'Username does not exist' });
    }

    // if (user.ACTIVE !== 1) {
    //   return res.status(403).json({ message: 'User account is inactive. Please contact admin.' });
    // }

    const isMatch = (password === user.PASSWORD);
    if (!isMatch) {
      return res.status(401).json({ message: 'Incorrect password' });
    }

    const token = jwt.sign(
      { id: user.ID, username: user.USERNAME, access_level: user.ACCESS_LEVEL, department: user.DEPARTMENT },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    const { PASSWORD, ...userData } = user;
    res.json({ message: 'Login successful', token, user: userData });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server/network error. Please try again later.' });
  }
};
