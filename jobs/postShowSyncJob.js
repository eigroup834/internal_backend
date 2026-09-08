const cron = require('node-cron');
const { getPool, withRetry } = require('../db');
const { TABLES } = require('../helper');
const sql = require('mssql');

const SOURCE_NAME = 'POST_SHOW_SALES';
const T = `dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}]`;
const STATE = `dbo.[${TABLES.VISITOR_SYNC_STATE}]`;

const BASE_URL = process.env.POST_SHOW_API_URL || 'https://eiindia.info/api/v1/integration/registrations';
const API_KEY = process.env.POST_SHOW_API_KEY || '';
const PAGE_SIZE = 500;
const CATEGORIES = 'VISITOR,DELEGATE,SPEAKER';

async function readCursor(pool) {
  const r = await withRetry(() => pool.request()
    .input('src', sql.VarChar(40), SOURCE_NAME)
    .query(`SELECT LAST_SYNCED_DATE FROM ${STATE} WHERE SOURCE_NAME = @src`));
  return r.recordset[0]?.LAST_SYNCED_DATE || null;
}

async function writeCursor(pool, lastDate, status, message) {
  await withRetry(() => pool.request()
    .input('src', sql.VarChar(40), SOURCE_NAME)
    .input('lastDate', sql.DateTime, lastDate)
    .input('status', sql.VarChar(20), status)
    .input('message', sql.NVarChar(1000), message || null)
    .query(`
      UPDATE ${STATE}
      SET LAST_SYNCED_DATE = COALESCE(@lastDate, LAST_SYNCED_DATE),
          LAST_RUN_DATE    = GETDATE(),
          LAST_RUN_STATUS  = @status,
          LAST_RUN_MESSAGE = @message
      WHERE SOURCE_NAME = @src;

      IF @@ROWCOUNT = 0
        INSERT INTO ${STATE} (SOURCE_NAME, LAST_SYNCED_DATE, LAST_RUN_DATE, LAST_RUN_STATUS, LAST_RUN_MESSAGE)
        VALUES (@src, @lastDate, GETDATE(), @status, @message);
    `));
}

async function fetchPage(page, since) {
  const url = new URL(BASE_URL);
  url.searchParams.set('category', CATEGORIES);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (since) url.searchParams.set('since', new Date(since).toISOString());

  const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`${SOURCE_NAME} API ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!body?.success) throw new Error(`${SOURCE_NAME} API returned success=false`);
  return { rows: body.data || [], meta: body.meta || {} };
}

async function upsertRows(pool, rows) {
  let written = 0;
  for (const r of rows) {
    if (!r?.id) continue;
    const result = await withRetry(() => pool.request()
      .input('sourceName', sql.VarChar(40), SOURCE_NAME)
      .input('sourceRefId', sql.VarChar(100), String(r.id))
      .input('category', sql.VarChar(20), r.category || 'VISITOR')
      .input('name', sql.NVarChar(200), r.name || null)
      .input('firstName', sql.NVarChar(100), r.firstName || null)
      .input('lastName', sql.NVarChar(100), r.lastName || null)
      .input('email', sql.NVarChar(200), r.email || null)
      .input('mobile', sql.VarChar(50), r.mobile || null)
      .input('designation', sql.NVarChar(150), r.designation || null)
      .input('company', sql.NVarChar(250), r.company || null)
      .input('industry', sql.NVarChar(200), r.industry || null)
      .input('eventName', sql.NVarChar(200), r.eventName || null)
      .input('registeredDate', sql.DateTime, r.registeredAt ? new Date(r.registeredAt) : null)
      .input('rawJson', sql.NVarChar(sql.MAX), JSON.stringify(r))
      .query(`
        UPDATE ${T}
        SET CATEGORY = @category, NAME = @name, FIRST_NAME = @firstName, LAST_NAME = @lastName,
            EMAIL = @email, MOBILE = @mobile, DESIGNATION = @designation, COMPANY = @company,
            INDUSTRY = @industry, EVENT_NAME = @eventName, REGISTERED_DATE = @registeredDate,
            RAW_JSON = @rawJson, UPDATED_DATE = GETDATE()
        WHERE SOURCE_NAME = @sourceName AND SOURCE_REF_ID = @sourceRefId
          AND PUSHED_BATCH_CODE IS NULL;

        IF @@ROWCOUNT = 0 AND NOT EXISTS (
          SELECT 1 FROM ${T} WHERE SOURCE_NAME = @sourceName AND SOURCE_REF_ID = @sourceRefId
        )
        BEGIN
          INSERT INTO ${T}
            (SOURCE_NAME, SOURCE_REF_ID, CATEGORY, NAME, FIRST_NAME, LAST_NAME, EMAIL, MOBILE,
             DESIGNATION, COMPANY, INDUSTRY, EVENT_NAME, REGISTERED_DATE, RAW_JSON, CREATED_DATE)
          VALUES
            (@sourceName, @sourceRefId, @category, @name, @firstName, @lastName, @email, @mobile,
             @designation, @company, @industry, @eventName, @registeredDate, @rawJson, GETDATE());
          SELECT 1 AS inserted;
        END
        ELSE SELECT 0 AS inserted;
      `));
    written += result.recordset?.[0]?.inserted || 0;
  }
  return written;
}

async function runPostShowSync() {
  if (!API_KEY) {
    console.warn('postShowSyncJob: POST_SHOW_API_KEY is not set — skipping.');
    return { skipped: true };
  }

  const pool = await getPool();
  const since = await readCursor(pool);
  let page = 1;
  let pages = 1;
  let seen = 0;
  let inserted = 0;
  let newest = since ? new Date(since) : null;

  try {
    do {
      const { rows, meta } = await fetchPage(page, since);
      pages = meta.pages || 1;
      seen += rows.length;
      inserted += await upsertRows(pool, rows);

      for (const r of rows) {
        const t = r.createdAt ? new Date(r.createdAt) : null;
        if (t && (!newest || t > newest)) newest = t;
      }
      page += 1;
    } while (page <= pages);

    const msg = `${seen} fetched, ${inserted} new`;
    await writeCursor(pool, newest, 'SUCCESS', msg);
    console.log(`postShowSyncJob: ${msg}`);
    return { seen, inserted };
  } catch (err) {
    await writeCursor(pool, null, 'FAILED', String(err.message).slice(0, 1000));
    console.error('postShowSyncJob error:', err.message);
    throw err;
  }
}

if (require.main === module) {
  runPostShowSync().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  const schedule = process.env.POST_SHOW_SYNC_CRON || '0 * * * *';
  cron.schedule(schedule, () => { runPostShowSync().catch(() => {}); });
  console.log(`postShowSyncJob scheduled: ${schedule}`);
}

module.exports = { runPostShowSync };
