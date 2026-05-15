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
  pool: {
    max: 20,
    min: 3,
    idleTimeoutMillis: 30000,
  },
};

const poolPromise = new sql.ConnectionPool(dbConfig)
  .connect()
  .then((pool) => {
    console.log("Connected");
    return pool;
  })
  .catch((err) => {
    console.error("Database Connection Failed", err);
    throw err;
  });

module.exports = {
  sql,
  poolPromise,
};
