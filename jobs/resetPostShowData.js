const { getPool, sql } = require('../db');
const { TABLES } = require('../helper');
process.env.POST_SHOW_SYNC_DISABLED = '1';
const { fetchPage, upsertRows, writeCursor } = require('./postShowSyncJob');

const SOURCE_NAME = 'POST_SHOW_SALES';
const LEADS = 'dbo.[' + TABLES.VISITOR_EXTERNAL_LEAD + ']';
const LOGS = 'dbo.[' + TABLES.VISITOR_EXTERNAL_LEAD_LOG + ']';
const apply = process.argv.includes('--apply');

async function getCounts(request) {
  const result = await request.input('src', sql.VarChar(40), SOURCE_NAME).query(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN worked.LEAD_ID IS NOT NULL THEN 1 ELSE 0 END), 0) AS preserved,
      COALESCE(SUM(CASE WHEN worked.LEAD_ID IS NULL THEN 1 ELSE 0 END), 0) AS removable
    FROM ${LEADS} el
    LEFT JOIN (SELECT DISTINCT LEAD_ID FROM ${LOGS}) worked ON worked.LEAD_ID = el.LEAD_ID
    WHERE el.SOURCE_NAME = @src;
  `);
  return result.recordset[0];
}

async function main() {
  const pool = await getPool();
  const before = await getCounts(pool.request());
  console.log('Post Show leads: ' + before.total + '; preserving logged: ' + before.preserved + '; removable: ' + before.removable + '.');
  if (!apply) {
    console.log('Dry run only. Use --apply to replace unlogged Post Show leads from the registration API.');
    return;
  }
  if (!process.env.POST_SHOW_API_KEY) throw new Error('POST_SHOW_API_KEY is missing; nothing deleted.');

  const rows = [];
  let page = 1, pages = 1;
  do {
    const result = await fetchPage(page, null);
    if (!Array.isArray(result.rows)) throw new Error('Invalid API data; nothing deleted.');
    pages = Number(result.meta.pages || 1);
    if (!Number.isInteger(pages) || pages < page) throw new Error('Invalid API pagination; nothing deleted.');
    rows.push(...result.rows);
    console.log('Fetched API page ' + page + '/' + pages + ': ' + result.rows.length + ' rows.');
    page++;
  } while (page <= pages);
  // This reset affects Post Show only; other registration sources stay untouched.
  const postShowRows = rows.filter(r => r?.dataCategory !== 'EXHIBITOR_TURNED_VISITOR');
  if (!postShowRows.length || postShowRows.some(r => !r?.id)) {
    throw new Error('Empty or invalid Post Show response; nothing deleted.');
  }

  const transaction = pool.transaction();
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const removed = await transaction.request().input('src', sql.VarChar(40), SOURCE_NAME).query(`
      SELECT el.LEAD_ID FROM ${LEADS} el
      WHERE el.SOURCE_NAME = @src
        AND EXISTS (SELECT 1 FROM ${LOGS} ll WHERE ll.LEAD_ID = el.LEAD_ID);
      DELETE el FROM ${LEADS} el WHERE el.SOURCE_NAME = @src
        AND NOT EXISTS (SELECT 1 FROM ${LOGS} ll WHERE ll.LEAD_ID = el.LEAD_ID);
      SELECT @@ROWCOUNT AS deleted;
    `);
    const inserted = await upsertRows(transaction, postShowRows, true);
    const verification = await transaction.request().query(`
      SELECT LEAD_ID FROM ${LEADS};
    `);
    const remainingIds = new Set(verification.recordset.map(r => String(r.LEAD_ID)));
    if (removed.recordsets[0].some(r => !remainingIds.has(String(r.LEAD_ID)))) {
      throw new Error('Logged lead preservation check failed.');
    }
    // Preserve the existing incremental cursor: the reset imports only Post Show rows.
    await writeCursor(transaction, null, 'SUCCESS', postShowRows.length + ' fetched; ' + inserted + ' inserted; logged leads preserved.');
    const after = await getCounts(transaction.request());
    await transaction.commit();
    console.log(JSON.stringify({ deleted: removed.recordsets[1][0].deleted, fetched: postShowRows.length, inserted, after }));
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('resetPostShowData error:', err.message);
  process.exit(1);
});
