const sql = require("mssql");
require("dotenv").config();

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_HOST,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  port: parseInt(process.env.DB_PORT, 10) || 1433,
  connectionTimeout: 30000,
  requestTimeout: 30000,
  pool: {
    max: 20,
    min: 0,
    idleTimeoutMillis: 300000,
  },
};

let pool = null;

async function getPool() {
  if (pool && pool.connected) return pool;
  if (pool && pool.connecting) {
    await new Promise((res) => setTimeout(res, 500));
    return getPool();
  }
  try {
    pool = await new sql.ConnectionPool(dbConfig).connect();
    pool.on("error", (err) => {
      console.error("[DB] Pool error, will reconnect on next request:", err.message);
      pool = null;
    });
    console.log("[DB] Connected");
    return pool;
  } catch (err) {
    pool = null;
    console.error("[DB] Connection failed:", err.message);
    throw err;
  }
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.number === 1205 && attempt < retries) {
        const delay = 100 * attempt + Math.random() * 200;
        console.warn(`[DB] Deadlock on attempt ${attempt}, retrying in ${Math.round(delay)}ms`);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
}

async function dbRequest(fn) {
  return withRetry(async () => {
    const pool = await getPool();
    return fn(pool.request());
  });
}

const poolPromise = getPool();

module.exports = {
  sql,
  poolPromise,
  getPool,
  withRetry,
  dbRequest,
};
