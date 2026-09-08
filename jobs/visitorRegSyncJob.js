const cron = require('node-cron');
const { getPool, withRetry } = require('../db');
const { TABLES } = require('../helper');
const sql = require('mssql');

const SOURCE_NAME = 'VISITOR_REGISTRATION';
const T = `dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}]`;
const STATE = `dbo.[${TABLES.VISITOR_SYNC_STATE}]`;

const API_URL = process.env.VISITOR_API_URL || '';
const API_KEY = process.env.VISITOR_API_KEY || '';
const API_TIMEOUT_MS = parseInt(process.env.VISITOR_API_TIMEOUT_MS, 10) || 20000;
const BATCH_SIZE = 500;

function fullName(r) {
  return [r.title, r.fname, r.lname]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ') || null;
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function readCursor(pool) {
  const r = await withRetry(() => pool.request()
    .input('src', sql.VarChar(40), SOURCE_NAME)
    .query(`SELECT LAST_SYNCED_ID FROM ${STATE} WHERE SOURCE_NAME = @src`));
  const n = parseInt(r.recordset[0]?.LAST_SYNCED_ID, 10);
  return Number.isInteger(n) ? n : 0;
}

async function writeCursor(pool, lastId, status, message) {
  await withRetry(() => pool.request()
    .input('src', sql.VarChar(40), SOURCE_NAME)
    .input('lastId', sql.VarChar(100), lastId === null ? null : String(lastId))
    .input('status', sql.VarChar(20), status)
    .input('message', sql.NVarChar(1000), message || null)
    .query(`
      UPDATE ${STATE}
      SET LAST_SYNCED_ID  = COALESCE(@lastId, LAST_SYNCED_ID),
          LAST_RUN_DATE   = GETDATE(),
          LAST_RUN_STATUS = @status,
          LAST_RUN_MESSAGE = @message
      WHERE SOURCE_NAME = @src;

      IF @@ROWCOUNT = 0
        INSERT INTO ${STATE} (SOURCE_NAME, LAST_SYNCED_ID, LAST_RUN_DATE, LAST_RUN_STATUS, LAST_RUN_MESSAGE)
        VALUES (@src, @lastId, GETDATE(), @status, @message);
    `));
}

async function fetchBatch(afterId) {
  const url = new URL(API_URL);
  url.searchParams.set('since_id', String(afterId));
  url.searchParams.set('top', String(BATCH_SIZE));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Source API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    const payload = await res.json();
    if (payload.status !== 'success') {
      throw new Error(`Source API error: ${payload.message || 'unexpected response'}`);
    }
    const rows = payload.data;
    if (!Array.isArray(rows)) throw new Error('Source API returned no data array');
    return { rows, lastId: payload.last_id };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Source API timed out after ${API_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function upsertRows(pool, rows) {
  let inserted = 0;
  for (const r of rows) {
    if (r.id === null || r.id === undefined) continue;
    const result = await withRetry(() => pool.request()
      .input('sourceName', sql.VarChar(40), SOURCE_NAME)
      .input('sourceRefId', sql.VarChar(100), String(r.id))
      .input('category', sql.VarChar(20), 'VISITOR')
      .input('name', sql.NVarChar(200), fullName(r))
      .input('firstName', sql.NVarChar(100), clean(r.fname))
      .input('lastName', sql.NVarChar(100), clean(r.lname))
      .input('email', sql.NVarChar(200), clean(r.email))
      .input('mobile', sql.VarChar(50), clean(r.mobile))
      .input('phone', sql.VarChar(50), clean(r.phone))
      .input('designation', sql.NVarChar(150), clean(r.designation))
      .input('department', sql.NVarChar(200), clean(r.department))
      .input('company', sql.NVarChar(250), clean(r.company))
      .input('city', sql.NVarChar(100), clean(r.city))
      .input('state', sql.NVarChar(100), clean(r.state))
      .input('country', sql.NVarChar(100), clean(r.country))
      .input('website', sql.NVarChar(200), clean(r.website))
      .input('ipAddress', sql.VarChar(45), clean(r.ip_address))
      .input('eventName', sql.NVarChar(200), clean(r.event_name))
      .input('registeredDate', sql.DateTime, toDate(r.create_date))
      .input('rawJson', sql.NVarChar(sql.MAX), JSON.stringify(r))
      .query(`
        UPDATE ${T}
        SET CATEGORY = @category, NAME = @name, FIRST_NAME = @firstName, LAST_NAME = @lastName,
            EMAIL = @email, MOBILE = @mobile, PHONE = @phone, DESIGNATION = @designation,
            DEPARTMENT = @department, COMPANY = @company, CITY = @city, STATE = @state,
            COUNTRY = @country, WEBSITE = @website, IP_ADDRESS = @ipAddress,
            EVENT_NAME = @eventName, REGISTERED_DATE = @registeredDate,
            RAW_JSON = @rawJson, UPDATED_DATE = GETDATE()
        WHERE SOURCE_NAME = @sourceName AND SOURCE_REF_ID = @sourceRefId
          AND PUSHED_BATCH_CODE IS NULL;

        IF @@ROWCOUNT = 0 AND NOT EXISTS (
          SELECT 1 FROM ${T} WHERE SOURCE_NAME = @sourceName AND SOURCE_REF_ID = @sourceRefId
        )
        BEGIN
          INSERT INTO ${T}
            (SOURCE_NAME, SOURCE_REF_ID, CATEGORY, NAME, FIRST_NAME, LAST_NAME, EMAIL, MOBILE, PHONE,
             DESIGNATION, DEPARTMENT, COMPANY, CITY, STATE, COUNTRY, WEBSITE, IP_ADDRESS,
             EVENT_NAME, REGISTERED_DATE, RAW_JSON, CREATED_DATE)
          VALUES
            (@sourceName, @sourceRefId, @category, @name, @firstName, @lastName, @email, @mobile, @phone,
             @designation, @department, @company, @city, @state, @country, @website, @ipAddress,
             @eventName, @registeredDate, @rawJson, GETDATE());
          SELECT 1 AS inserted;
        END
        ELSE SELECT 0 AS inserted;
      `));
    inserted += result.recordset?.[0]?.inserted || 0;
  }
  return inserted;
}

async function runVisitorRegSync() {
  if (!API_URL || !API_KEY) {
    console.warn('visitorRegSyncJob: VISITOR_API_URL / VISITOR_API_KEY not set — skipping.');
    return { skipped: true };
  }

  const pool = await getPool();
  let afterId = await readCursor(pool);
  let seen = 0;
  let inserted = 0;

  try {
    for (;;) {
      const { rows, lastId } = await fetchBatch(afterId);
      if (rows.length === 0) break;

      seen += rows.length;
      inserted += await upsertRows(pool, rows);

      const maxId = Number.isInteger(lastId)
        ? lastId
        : rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), afterId);
      if (maxId <= afterId) break;
      afterId = maxId;

      await writeCursor(pool, afterId, 'RUNNING', `${seen} fetched, ${inserted} new`);
      if (rows.length < BATCH_SIZE) break;
    }

    const msg = `${seen} fetched, ${inserted} new`;
    await writeCursor(pool, afterId, 'SUCCESS', msg);
    console.log(`visitorRegSyncJob: ${msg} (cursor at id ${afterId})`);
    return { seen, inserted };
  } catch (err) {
    await writeCursor(pool, null, 'FAILED', String(err.message).slice(0, 1000));
    console.error('visitorRegSyncJob error:', err.message);
    throw err;
  }
}

if (require.main === module) {
  runVisitorRegSync().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  const schedule = process.env.VISITOR_REG_SYNC_CRON || '15 * * * *';
  cron.schedule(schedule, () => { runVisitorRegSync().catch(() => {}); });
  console.log(`visitorRegSyncJob scheduled: ${schedule}`);
}

module.exports = { runVisitorRegSync };
