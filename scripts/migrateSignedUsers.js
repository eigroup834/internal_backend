// Run manually from backend after deploying compatibility code.
const fs = require('node:fs');
const bcrypt = require('bcrypt');
const { migrationFingerprint, signUser, verifyUser, userSchema } = require('../utils/roleSignature');
const { poolPromise, sql } = require('../db');
const [mode, file] = process.argv.slice(2);
function reviewMatches(row, entry) {
  return entry && migrationFingerprint(row) === entry.fingerprint && String(entry.username) === String(row.USERNAME)
    && String(entry.primaryRole) === String(row.ACCESS_LEVEL) && String(entry.roles) === String(row.ACCESS_LEVELS ?? row.ACCESS_LEVEL)
    && entry.active === Boolean(row.ACTIVE);
}
async function main() {
  if (!['--prepare', '--snapshot', '--apply', '--check'].includes(mode)
    || (['--snapshot', '--apply'].includes(mode) && !file)) {
    throw new Error('Usage: node scripts/migrateSignedUsers.js --prepare | --snapshot <review.json> | --apply <review.json> | --check');
  }
  const pool = await poolPromise;
  if (mode === '--prepare') {
    await pool.request().batch(`
      IF COL_LENGTH('dbo.USER', 'ACCESS_LEVELS') IS NULL ALTER TABLE dbo.[USER] ADD ACCESS_LEVELS VARCHAR(50) NULL;
      IF COL_LENGTH('dbo.USER', 'ROLE_SIGNATURE') IS NULL ALTER TABLE dbo.[USER] ADD ROLE_SIGNATURE VARCHAR(64) NULL;
    `);
    console.log('User table prepared. Existing records and roles unchanged. Safe to rerun.');
    return;
  }
  const schema = await userSchema(pool);
  if ((mode === '--apply' || mode === '--check') && (!schema.signature || !schema.levels)) throw new Error('Run --prepare first.');
  const result = await pool.request().query('SELECT * FROM dbo.[USER] ORDER BY USER_CODE');
  if (mode === '--snapshot') {
    const users = result.recordset.map(u => ({ userCode: u.USER_CODE, username: u.USERNAME,
      primaryRole: u.ACCESS_LEVEL, roles: u.ACCESS_LEVELS ?? String(u.ACCESS_LEVEL), active: Boolean(u.ACTIVE), fingerprint: migrationFingerprint(u) }));
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, users }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Prepared ${users.length} accounts for review. Database unchanged.`);
    return;
  }
  // Validate the key before attempting any updates or readiness checks.
  signUser({ ID: 0, USER_CODE: 'check', USERNAME: 'check', DEPARTMENT: '', PASSWORD: 'check', ACTIVE: false, ACCESS_LEVEL: '1', ACCESS_LEVELS: null });
  if (mode === '--check') {
    let invalid = 0;
    for (const row of result.recordset) {
      if (row.ACTIVE && (!verifyUser(row) || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(row.PASSWORD))) invalid++;
    }
    console.log(`Active accounts not ready for strict verification: ${invalid}`);
    if (invalid) process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.users) || !manifest.users.length) throw new Error('Invalid review file.');
  const approved = new Map(manifest.users.map(u => [u.userCode, u]));
  if (approved.size !== manifest.users.length) throw new Error('Duplicate user codes in review file.');
  const codes = new Set(result.recordset.map(u => u.USER_CODE));
  const counts = { migrated: 0, alreadySigned: 0, skipped: [...approved.keys()].filter(code => !codes.has(code)).length };
  for (const row of result.recordset) {
    if (row.ROLE_SIGNATURE) {
      if (verifyUser(row)) counts.alreadySigned++;
      else { counts.skipped++; console.error(`Invalid signature; manual review required: ${row.USER_CODE}`); }
      continue;
    }
    const entry = approved.get(row.USER_CODE);
    if (!reviewMatches(row, entry)) { counts.skipped++; console.error(`Unreviewed or changed account skipped: ${row.USER_CODE}`); continue; }
    const hashed = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(row.PASSWORD);
    if (!hashed && Buffer.byteLength(row.PASSWORD, 'utf8') > 72) { counts.skipped++; console.error(`Password requires separate migration: ${row.USER_CODE}`); continue; }
    // Hash outside the transaction so normal requests are not held while bcrypt works.
    const password = hashed ? row.PASSWORD : await bcrypt.hash(row.PASSWORD, 12);
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const current = await new sql.Request(transaction).input('code', sql.VarChar(50), row.USER_CODE)
        .query('SELECT * FROM dbo.[USER] WITH (UPDLOCK, HOLDLOCK) WHERE USER_CODE = @code');
      if (current.recordset.length !== 1 || !reviewMatches(current.recordset[0], entry)) {
        await transaction.rollback(); counts.skipped++; console.error(`Account changed during migration: ${row.USER_CODE}`); continue;
      }
      const signature = signUser({ ...current.recordset[0], PASSWORD: password });
      const update = await new sql.Request(transaction).input('code', sql.VarChar(50), row.USER_CODE)
        .input('password', sql.VarChar(255), password).input('signature', sql.VarChar(64), signature)
        .query('UPDATE dbo.[USER] SET PASSWORD = @password, ROLE_SIGNATURE = @signature WHERE USER_CODE = @code');
      if (update.rowsAffected[0] !== 1) throw new Error('User code is not unique.');
      await transaction.commit(); counts.migrated++;
    } catch (err) { await transaction.rollback(); throw err; }
  }
  console.log(JSON.stringify(counts));
  if (counts.skipped) { process.exitCode = 1; console.error('Review skipped accounts in a fresh snapshot, rerun --apply, then run --check. Keep compatibility mode enabled.'); }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(async () => {
  try { await (await poolPromise).close(); } catch {}
});
