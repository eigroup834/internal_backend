const { poolPromise, sql } = require('../db');
const { TABLES } = require('../helper');
const ExcelJS = require('exceljs');

const VISITOR_HEAD_LEVELS = [2, 5];
const isVisitorHead = (req) => VISITOR_HEAD_LEVELS.includes(Number(req.user?.access_level));

const PERSON_COLS = `
  LTRIM(RTRIM(ISNULL(CP.PREFIX,'') + ' ' + ISNULL(CP.FNAME,'') + ' ' + ISNULL(CP.LNAME,''))) AS PERSON_NAME,
  CASE WHEN ISJSON(CP.DESIG)=1        THEN JSON_VALUE(CP.DESIG,'$[0].value')   ELSE CP.DESIG END AS DESIGNATION,
  CASE WHEN ISJSON(CP.DEPT)=1         THEN JSON_VALUE(CP.DEPT,'$[0]')          ELSE CP.DEPT  END AS DEPARTMENT,
  CASE WHEN ISJSON(CP.MOBILE)=1       THEN JSON_VALUE(CP.MOBILE,'$[0].number') ELSE NULL END AS MOBILE,
  CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[0]')  ELSE NULL END AS EMAIL,
  CD.COMPANY_NAME, CD.DIVISION, CD.CITY, CD.STATE, CD.COUNTRY`;

const PERSON_JOINS = `
  LEFT JOIN dbo.[${TABLES.COMP_PERSON}]    CP ON CP.PERSON_CODE  = c.PERSON_CODE
  LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] CD ON CD.COMPANY_CODE = c.COMPANY_CODE`;

const SEARCH_PERSON_NAME = `LTRIM(RTRIM(ISNULL(CP.PREFIX,'') + ' ' + ISNULL(CP.FNAME,'') + ' ' + ISNULL(CP.LNAME,'')))`;

const CONTACT_ALIASES = `
  c.CONTACT_CODE          AS CONTACT_ID,
  c.BATCH_CODE            AS BATCH_ID,
  c.ASSIGNED_TO_USER_CODE AS ASSIGNED_TO`;

const MY_CONTACTS_SORT = {
  contact:     SEARCH_PERSON_NAME,
  designation: `CASE WHEN ISJSON(CP.DESIG)=1 THEN JSON_VALUE(CP.DESIG,'$[0].value') ELSE CP.DESIG END`,
  department:  `CASE WHEN ISJSON(CP.DEPT)=1  THEN JSON_VALUE(CP.DEPT,'$[0]')         ELSE CP.DEPT  END`,
  mobile:      `CASE WHEN ISJSON(CP.MOBILE)=1 THEN JSON_VALUE(CP.MOBILE,'$[0].number') ELSE NULL END`,
  email:       `CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[0]') ELSE NULL END`,
  industry:    `CSI.INDUSTRIES`,
  batch:       `b.BATCH_NAME`,
  status:      `LatestLog.STATUS`,
  updated:     `LatestLog.CREATED_DATE`,
};

function buildReportParts(params, request) {
  const {
    exhName, attendee, event,
    exhType = 'person',
    industries, segments,
    dateFrom, dateTo,
  } = params;

  const whereClauses = ['1=1'];
  const industryList = industries ? industries.split(',').filter(Boolean) : [];
  const segmentList  = segments  ? segments.split(',').filter(Boolean)  : [];

  let exhApplySQL = '';
  const needsExh  = !!(exhName || attendee || event);

  if (needsExh) {
    const conds = [];
    if (exhName)  { request.input('exhName',  sql.NVarChar, `%${exhName}%`);  conds.push('EXH_NAME LIKE @exhName'); }
    if (attendee) { request.input('attendee', sql.NVarChar, `%${attendee}%`); conds.push('ATTENDEE LIKE @attendee'); }
    if (event)    { request.input('event',    sql.NVarChar, `%${event}%`);    conds.push('EVENT LIKE @event'); }
    const exhWhere    = conds.length ? 'WHERE '  + conds.join(' AND ') : '';
    const exhAndConds = conds.length ? ' AND '   + conds.join(' AND ') : '';
    if (exhType === 'company') {
      whereClauses.push(`CP.COMPANY_CODE IN (SELECT COMPANY_CODE FROM dbo.[${TABLES.COMP_EXH_HISTORY}] ${exhWhere})`);
      exhApplySQL = `OUTER APPLY (SELECT TOP 1 EXH_NAME FROM dbo.[${TABLES.COMP_EXH_HISTORY}] WHERE COMPANY_CODE=CP.COMPANY_CODE${exhAndConds}) EHD`;
    } else {
      whereClauses.push(`CP.PERSON_CODE IN (SELECT PERSON_CODE FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] ${exhWhere})`);
      exhApplySQL = `OUTER APPLY (SELECT TOP 1 EXH_NAME FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] WHERE PERSON_CODE=CP.PERSON_CODE${exhAndConds}) EHD`;
    }
  }

  if (dateFrom) { request.input('dateFrom', sql.Date, dateFrom); whereClauses.push('CAST(CP.UPDATED_DATE AS DATE) >= @dateFrom'); }
  if (dateTo)   { request.input('dateTo',   sql.Date, dateTo);   whereClauses.push('CAST(CP.UPDATED_DATE AS DATE) <= @dateTo'); }

  if (industryList.length > 0) {
    const p = industryList.map((v, i) => { request.input(`ind_${i}`, sql.NVarChar, v); return `@ind_${i}`; });
    whereClauses.push(`EXISTS (SELECT 1 FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m2 JOIN dbo.[${TABLES.INDSEGMENT}] s2 ON m2.SEG_CODE=s2.SEG_CODE WHERE m2.COMPANY_CODE=CP.COMPANY_CODE AND s2.INDUSTRY IN (${p.join(',')}))`);
  }
  if (segmentList.length > 0) {
    const p = segmentList.map((v, i) => { request.input(`seg_${i}`, sql.NVarChar, v); return `@seg_${i}`; });
    whereClauses.push(`EXISTS (SELECT 1 FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m3 WHERE m3.COMPANY_CODE=CP.COMPANY_CODE AND m3.SEG_CODE IN (${p.join(',')}))`);
  }

  return { whereSQL: 'WHERE ' + whereClauses.join(' AND '), exhApplySQL };
}

const CTE_COMP_SEG = `
  WITH CompSegInfo AS (
    SELECT m.COMPANY_CODE,
      STRING_AGG(s.SEGMENT,  ', ') AS SEGMENTS,
      STRING_AGG(s.INDUSTRY, ', ') AS INDUSTRIES
    FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
    JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
    GROUP BY m.COMPANY_CODE
  )`;

function createTtlCache(ttlMs) {
  const store = new Map();
  return async (key, producer) => {
    const hit = store.get(key);
    if (hit) {
      if (hit.promise) return hit.promise;          
      if (hit.expires > Date.now()) return hit.value; 
    }
    const promise = Promise.resolve().then(producer).then(
      (value) => { store.set(key, { value, expires: Date.now() + ttlMs }); return value; },
      (err)   => { store.delete(key); throw err; }
    );
    store.set(key, { promise });
    return promise;
  };
}

exports.getReportPreview = async (req, res) => {
  try {
    const pool    = await poolPromise;
    const request = pool.request();
    const { whereSQL, exhApplySQL } = buildReportParts(req.query, request);

    const query = `
      ${CTE_COMP_SEG}
      SELECT TOP 100
        CP.PERSON_CODE, CP.COMPANY_CODE,
        LTRIM(RTRIM(ISNULL(CP.PREFIX,'') + ' ' + ISNULL(CP.FNAME,'') + ' ' + ISNULL(CP.LNAME,''))) AS PERSON_NAME,
        CASE WHEN ISJSON(CP.DESIG)=1 THEN JSON_VALUE(CP.DESIG,'$[0].value') ELSE CP.DESIG END AS DESIGNATION,
        CD.COMPANY_NAME, CD.DIVISION, CD.CITY, CD.STATE, CD.COUNTRY,
        CASE WHEN ISJSON(CP.MOBILE)=1       THEN JSON_VALUE(CP.MOBILE,'$[0].number')       ELSE NULL END AS MOBILE,
        CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[0]')        ELSE NULL END AS EMAIL,
        CSI.INDUSTRIES AS INDUSTRY, CSI.SEGMENTS AS SEGMENT,
        CP.UPDATED_DATE AS SOURCE_UPDATED
      FROM dbo.[${TABLES.COMP_PERSON}] CP
      LEFT JOIN dbo.[${TABLES.COMP_MASTER}]    CM  ON CM.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] CD  ON CD.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN CompSegInfo                    CSI ON CSI.COMPANY_CODE = CP.COMPANY_CODE
      ${exhApplySQL}
      ${whereSQL}
      ORDER BY CP.COMPANY_CODE, CP.PERSON_CODE;

      ${CTE_COMP_SEG}
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.COMP_PERSON}] CP
      LEFT JOIN dbo.[${TABLES.COMP_MASTER}]    CM  ON CM.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] CD  ON CD.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN CompSegInfo                    CSI ON CSI.COMPANY_CODE = CP.COMPANY_CODE
      ${exhApplySQL}
      ${whereSQL};
    `;

    const result = await request.query(query);
    res.json({
      data:    result.recordsets[0],
      total:   result.recordsets[1][0].total,
      capped:  result.recordsets[1][0].total > 100,
    });
  } catch (err) {
    console.error('getReportPreview error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createBatch = async (req, res) => {
  try {
    const {
      batchName, batchYear, notes, assignedTo,
      exhName, attendee, event, exhType,
      industries, segments, dateFrom, dateTo,
    } = req.body;

    if (!batchName || !batchYear) {
      return res.status(400).json({ error: 'Batch name and year are required' });
    }

    const pool    = await poolPromise;

    const ACTIVE_CONTACT_CAP = 200000;
    const capCheck = await pool.request().query(`
      SELECT COUNT(*) AS activeTotal
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] bc
      JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = bc.BATCH_CODE
      WHERE b.STATUS = 'Y';
    `);
    const activeTotal = capCheck.recordset[0].activeTotal;
    const remaining   = ACTIVE_CONTACT_CAP - activeTotal;
    if (remaining <= 0) {
      return res.status(400).json({
        error: 'You already have many active batches open and the 2 lakh contact limit is full. Please close or delete some batches and reassign before creating a new one.',
      });
    }

    const request = pool.request();
    request.input('remainingCap', sql.Int, remaining);

    const { whereSQL, exhApplySQL } = buildReportParts(
      { exhName, attendee, event, exhType, industries, segments, dateFrom, dateTo },
      request
    );

    request.input('batchName', sql.NVarChar(200),  batchName);
    request.input('batchYear', sql.Int,            parseInt(batchYear));
    request.input('remarks',   sql.NVarChar(1000), notes || null);
    request.input('userCode',  sql.VarChar(100),   assignedTo || (req.user?.user_code || null));

    // BATCH_CODE / CONTACT_CODE are varchar codes generated with NEWID().
    const insertQuery = `
      DECLARE @batchCode VARCHAR(100) = CONVERT(VARCHAR(36), NEWID());

      INSERT INTO dbo.[${TABLES.VISITOR_BATCH}]
        (BATCH_CODE, BATCH_NAME, BATCH_YEAR, REMARKS, STATUS, USER_CODE, TOTAL_CONTACTS, CREATED_DATE)
      VALUES
        (@batchCode, @batchName, @batchYear, @remarks, 'Y', @userCode, 0, GETDATE());

      INSERT INTO dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
        (CONTACT_CODE, BATCH_CODE, PERSON_CODE, COMPANY_CODE, STATUS, CREATED_DATE)
      SELECT TOP (@remainingCap)
        CONVERT(VARCHAR(36), NEWID()), @batchCode, CP.PERSON_CODE, CP.COMPANY_CODE, 'NEW', GETDATE()
      FROM dbo.[${TABLES.COMP_PERSON}] CP
      LEFT JOIN dbo.[${TABLES.COMP_MASTER}]    CM  ON CM.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] CD  ON CD.COMPANY_CODE  = CP.COMPANY_CODE
      ${exhApplySQL}
      ${whereSQL};

      UPDATE dbo.[${TABLES.VISITOR_BATCH}]
      SET TOTAL_CONTACTS = (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] WHERE BATCH_CODE = @batchCode)
      WHERE BATCH_CODE = @batchCode;

      SELECT @batchCode AS BATCH_ID,
             (SELECT TOTAL_CONTACTS FROM dbo.[${TABLES.VISITOR_BATCH}] WHERE BATCH_CODE = @batchCode) AS TOTAL_CONTACTS;
    `;

    const result  = await request.query(insertQuery);
    const created = result.recordset[0];
    const capped  = created.TOTAL_CONTACTS >= remaining; // insert hit the remaining room
    res.json({
      success:       true,
      batchId:       created.BATCH_ID,
      totalContacts: created.TOTAL_CONTACTS,
      capped,
      message: capped
        ? 'This batch was capped to stay within the 2 lakh active-contact limit, so not all matching contacts were added. You have many batches open — please close some and reassign as needed.'
        : undefined,
    });
  } catch (err) {
    console.error('createBatch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Reads the two-column (Person Code / Company Code) sheet from an uploaded
// workbook. Header names are matched loosely (case/space/underscore-insensitive)
// so "Person Code", "PERSON_CODE", "personcode" etc. all resolve the same way.
const normalizeHeader = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');

async function readPersonCompanyRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The uploaded file has no sheet');

  const headerRow = sheet.getRow(1);
  let personColIdx = null;
  let companyColIdx = null;
  headerRow.eachCell((cell, colNumber) => {
    const h = normalizeHeader(cell.value);
    if (h === 'personcode') personColIdx = colNumber;
    if (h === 'companycode') companyColIdx = colNumber;
  });
  if (!personColIdx || !companyColIdx) {
    throw new Error('The Excel file must have "Person Code" and "Company Code" columns');
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const personCode = String(row.getCell(personColIdx).value ?? '').trim();
    const companyCode = String(row.getCell(companyColIdx).value ?? '').trim();
    if (personCode && companyCode) rows.push({ personCode, companyCode });
  });
  return rows;
}

exports.uploadBatch = async (req, res) => {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  let began = false;
  try {
    const { batchName, notes } = req.body;
    if (!batchName || !batchName.trim()) {
      return res.status(400).json({ error: 'Batch name is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'An Excel file is required' });
    }

    const rows = await readPersonCompanyRows(req.file.buffer);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid Person Code / Company Code rows found in the file' });
    }

    await transaction.begin();
    began = true;

    const setupReq = new sql.Request(transaction);
    await setupReq.query('CREATE TABLE #Upload (PERSON_CODE VARCHAR(100), COMPANY_CODE VARCHAR(100));');

    const CHUNK = 500; // keeps each round trip well under SQL Server's parameter cap
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const chunkReq = new sql.Request(transaction);
      const placeholders = chunk.map((_, idx) => `(@p${idx}, @c${idx})`).join(',');
      chunk.forEach((r, idx) => {
        chunkReq.input(`p${idx}`, sql.VarChar(100), r.personCode);
        chunkReq.input(`c${idx}`, sql.VarChar(100), r.companyCode);
      });
      await chunkReq.query(`INSERT INTO #Upload (PERSON_CODE, COMPANY_CODE) VALUES ${placeholders};`);
    }

    const finalReq = new sql.Request(transaction);
    finalReq.input('batchName', sql.NVarChar(200), batchName.trim());
    finalReq.input('batchYear', sql.Int, new Date().getFullYear());
    finalReq.input('remarks', sql.NVarChar(1000), notes || null);
    finalReq.input('userCode', sql.VarChar(100), req.user?.user_code || null);

    const finalSql = `
      DECLARE @batchCode VARCHAR(100) = CONVERT(VARCHAR(36), NEWID());
      DECLARE @uniqueCount INT, @dupCount INT, @missingCount INT, @eligibleCount INT;

      SELECT DISTINCT PERSON_CODE, COMPANY_CODE
      INTO #Deduped
      FROM #Upload
      WHERE PERSON_CODE <> '' AND COMPANY_CODE <> '';
      SET @uniqueCount = @@ROWCOUNT;

      SELECT
        d.PERSON_CODE, d.COMPANY_CODE,
        CASE WHEN EXISTS (
          SELECT 1 FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] bc
          WHERE bc.PERSON_CODE = d.PERSON_CODE AND bc.COMPANY_CODE = d.COMPANY_CODE
        ) THEN 1 ELSE 0 END AS IS_DUP,
        (CASE WHEN ISJSON(cp.MOBILE)=1       THEN JSON_VALUE(cp.MOBILE,'$[0].number') ELSE NULL END) AS MOBILE_VAL,
        (CASE WHEN ISJSON(cp.PERSON_EMAIL)=1 THEN JSON_VALUE(cp.PERSON_EMAIL,'$[0]')  ELSE NULL END) AS EMAIL_VAL
      INTO #Checked
      FROM #Deduped d
      LEFT JOIN dbo.[${TABLES.COMP_PERSON}] cp ON cp.PERSON_CODE = d.PERSON_CODE;

      SELECT DISTINCT PERSON_CODE, COMPANY_CODE
      INTO #Eligible
      FROM #Checked
      WHERE IS_DUP = 0 AND MOBILE_VAL IS NOT NULL AND EMAIL_VAL IS NOT NULL;

      SET @dupCount      = (SELECT COUNT(*) FROM #Checked WHERE IS_DUP = 1);
      SET @missingCount  = (SELECT COUNT(*) FROM #Checked WHERE IS_DUP = 0 AND (MOBILE_VAL IS NULL OR EMAIL_VAL IS NULL));
      SET @eligibleCount = (SELECT COUNT(*) FROM #Eligible);

      IF @eligibleCount > 0
      BEGIN
        INSERT INTO dbo.[${TABLES.VISITOR_BATCH}]
          (BATCH_CODE, BATCH_NAME, BATCH_YEAR, REMARKS, STATUS, USER_CODE, TOTAL_CONTACTS, CREATED_DATE)
        VALUES
          (@batchCode, @batchName, @batchYear, @remarks, 'Y', @userCode, @eligibleCount, GETDATE());

        INSERT INTO dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
          (CONTACT_CODE, BATCH_CODE, PERSON_CODE, COMPANY_CODE, STATUS, CREATED_DATE)
        SELECT CONVERT(VARCHAR(36), NEWID()), @batchCode, PERSON_CODE, COMPANY_CODE, 'NEW', GETDATE()
        FROM #Eligible;
      END

      SELECT
        CASE WHEN @eligibleCount > 0 THEN @batchCode ELSE NULL END AS BATCH_ID,
        @uniqueCount   AS UNIQUE_ROWS,
        @dupCount      AS DUPLICATE_SKIPPED,
        @missingCount  AS MISSING_SKIPPED,
        @eligibleCount AS IMPORTED;
    `;
    const result = await finalReq.query(finalSql);
    await transaction.commit();
    began = false;

    const summary = result.recordset[0];
    if (!summary.IMPORTED) {
      return res.status(400).json({
        error: `No records were imported — ${summary.DUPLICATE_SKIPPED} already existed and ${summary.MISSING_SKIPPED} are missing a mobile number or email.`,
        totalRowsInFile: rows.length,
        uniqueRows: summary.UNIQUE_ROWS,
        duplicateSkipped: summary.DUPLICATE_SKIPPED,
        missingSkipped: summary.MISSING_SKIPPED,
      });
    }

    res.json({
      success: true,
      batchId: summary.BATCH_ID,
      totalRowsInFile: rows.length,
      inFileDuplicates: rows.length - summary.UNIQUE_ROWS,
      duplicateSkipped: summary.DUPLICATE_SKIPPED,
      missingSkipped: summary.MISSING_SKIPPED,
      imported: summary.IMPORTED,
    });
  } catch (err) {
    if (began) { try { await transaction.rollback(); } catch {} }
    console.error('uploadBatch error:', err);
    res.status(err.message && !err.number ? 400 : 500).json({ error: err.message || 'Server error' });
  }
};

exports.getMyCreatedBatches = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum  = parseInt(page, 10)  || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const offset   = (pageNum - 1) * limitNum;

    const pool    = await poolPromise;
    const request = pool.request();
    request.input('me', sql.VarChar(100), req.user?.user_code || '');

    const q = `
      SELECT b.BATCH_CODE AS BATCH_ID, b.BATCH_NAME, b.REMARKS, b.BATCH_YEAR,
             b.TOTAL_CONTACTS, b.STATUS, b.CREATED_DATE,
             ROW_NUMBER() OVER (ORDER BY b.CREATED_DATE DESC) AS RowNum
      FROM dbo.[${TABLES.VISITOR_BATCH}] b
      WHERE b.USER_CODE = @me
    `;

    const result = await request.query(`
      SELECT * FROM (${q}) x WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
      SELECT COUNT(*) AS total FROM dbo.[${TABLES.VISITOR_BATCH}] WHERE USER_CODE = @me;
    `);

    res.json({
      data:  result.recordsets[0],
      total: result.recordsets[1][0].total,
      page:  pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error('getMyCreatedBatches error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getBatches = async (req, res) => {
  try {
    const { year, search = '', page = 1, limit = 20 } = req.query;
    const pageNum   = parseInt(page, 10)  || 1;
    const limitNum  = parseInt(limit, 10) || 20;
    const offset    = (pageNum - 1) * limitNum;
    const pool      = await poolPromise;
    const request   = pool.request();

    const isHead = isVisitorHead(req);
    if (!isHead) request.input('me', sql.VarChar(100), req.user?.user_code || '');

    const where = ["b.STATUS = 'Y'"];
    if (year)   { request.input('yr', sql.Int,      parseInt(year)); where.push('b.BATCH_YEAR = @yr'); }
    if (search) { request.input('s',  sql.NVarChar, `%${search}%`);  where.push('b.BATCH_NAME LIKE @s'); }
    if (!isHead) {
      where.push(`EXISTS (SELECT 1 FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] mc WHERE mc.BATCH_CODE = b.BATCH_CODE AND mc.ASSIGNED_TO_USER_CODE = @me)`);
    }
    const whereSQL = 'WHERE ' + where.join(' AND ');
    // Non-heads only see stats for their own contacts within each batch, not the whole team's.
    const statsScopeSQL = isHead ? '' : 'WHERE ASSIGNED_TO_USER_CODE = @me';

    const q = `
      WITH BatchStats AS (
        SELECT BATCH_CODE,
          COUNT(*) AS total,
          SUM(CASE WHEN ASSIGNED_TO_USER_CODE IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
          SUM(CASE WHEN STATUS = 'DONE'         THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN STATUS = 'INTERESTED'   THEN 1 ELSE 0 END) AS interested,
          SUM(CASE WHEN STATUS = 'WORKING'      THEN 1 ELSE 0 END) AS working
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
        ${statsScopeSQL}
        GROUP BY BATCH_CODE
      ),
      Batches AS (
        SELECT b.*,
          b.BATCH_CODE AS BATCH_ID,
          ISNULL(s.total, 0) AS STAT_TOTAL,
          ISNULL(s.assigned, 0) AS STAT_ASSIGNED,
          ISNULL(s.done, 0) AS STAT_DONE,
          u.USERNAME AS ASSIGNED_TO_NAME,
          ROW_NUMBER() OVER (ORDER BY b.CREATED_DATE DESC) AS RowNum
        FROM dbo.[${TABLES.VISITOR_BATCH}] b
        LEFT JOIN BatchStats s ON s.BATCH_CODE = b.BATCH_CODE
        LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = b.USER_CODE
        ${whereSQL}
      )
      SELECT * FROM Batches WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.VISITOR_BATCH}] b
      ${whereSQL};

      SELECT DISTINCT BATCH_YEAR AS year
      FROM dbo.[${TABLES.VISITOR_BATCH}]
      ORDER BY BATCH_YEAR DESC;
    `;

    const result = await request.query(q);
    res.json({
      data:       result.recordsets[0],
      total:      result.recordsets[1][0].total,
      years:      result.recordsets[2].map(r => r.year),
      industries: [],
      segments:   [],
      page:       pageNum,
      limit:      limitNum,
    });
  } catch (err) {
    console.error('getBatches error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getBatchDetail = async (req, res) => {
  try {
    const { batchId } = req.params;
    const pool    = await poolPromise;
    const request = pool.request();
    request.input('batchId', sql.VarChar(100), batchId);

    const isHead = isVisitorHead(req);
    if (!isHead) request.input('me', sql.VarChar(100), req.user?.user_code || '');
    
    const statScope = isHead ? '' : 'AND ASSIGNED_TO_USER_CODE = @me';
    const memberScope = isHead ? '' : 'AND c.ASSIGNED_TO_USER_CODE = @me';

    const q = `
      WITH Stat AS (
        SELECT
          COUNT(*)                                                              AS STAT_TOTAL,
          SUM(CASE WHEN ASSIGNED_TO_USER_CODE IS NOT NULL THEN 1 ELSE 0 END)    AS STAT_ASSIGNED,
          SUM(CASE WHEN ASSIGNED_TO_USER_CODE IS NULL     THEN 1 ELSE 0 END)    AS STAT_UNASSIGNED,
          SUM(CASE WHEN STATUS='WORKING'        THEN 1 ELSE 0 END)              AS STAT_WORKING,
          SUM(CASE WHEN STATUS='DONE'           THEN 1 ELSE 0 END)              AS STAT_DONE,
          SUM(CASE WHEN STATUS='INTERESTED'     THEN 1 ELSE 0 END)              AS STAT_INTERESTED,
          SUM(CASE WHEN STATUS='NOT_INTERESTED' THEN 1 ELSE 0 END)              AS STAT_NOT_INTERESTED,
          SUM(CASE WHEN STATUS='CALLBACK'       THEN 1 ELSE 0 END)              AS STAT_CALLBACK,
          SUM(CASE WHEN STATUS='NO_RESPONSE'    THEN 1 ELSE 0 END)              AS STAT_NO_RESPONSE
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
        WHERE BATCH_CODE = @batchId ${statScope}
      )
      SELECT b.*,
        b.BATCH_CODE AS BATCH_ID,
        u.USERNAME AS ASSIGNED_TO_NAME,
        Stat.STAT_TOTAL, Stat.STAT_ASSIGNED, Stat.STAT_UNASSIGNED, Stat.STAT_WORKING,
        Stat.STAT_DONE, Stat.STAT_INTERESTED, Stat.STAT_NOT_INTERESTED, Stat.STAT_CALLBACK, Stat.STAT_NO_RESPONSE
      FROM dbo.[${TABLES.VISITOR_BATCH}] b
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = b.USER_CODE
      CROSS JOIN Stat
      WHERE b.BATCH_CODE = @batchId;

      SELECT
        c.ASSIGNED_TO_USER_CODE AS ASSIGNED_TO,
        u.USERNAME AS MEMBER_NAME,
        (SELECT TOP 1 u2.USERNAME
           FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c2
           LEFT JOIN dbo.[${TABLES.USER}] u2 ON u2.USER_CODE = c2.ASSIGNED_BY_USER_CODE
           WHERE c2.BATCH_CODE = c.BATCH_CODE
             AND c2.ASSIGNED_TO_USER_CODE = c.ASSIGNED_TO_USER_CODE
           ORDER BY c2.ASSIGNED_DATE DESC)                                          AS ASSIGNED_BY_NAME,
        COUNT(*)                                                                    AS ASSIGNED_COUNT,
        SUM(CASE WHEN c.STATUS NOT IN ('NEW','ASSIGNED') THEN 1 ELSE 0 END)        AS WORKED_COUNT,
        SUM(CASE WHEN c.STATUS = 'WORKING'       THEN 1 ELSE 0 END)               AS WORKING_COUNT,
        SUM(CASE WHEN c.STATUS = 'INTERESTED'    THEN 1 ELSE 0 END)               AS INTERESTED_COUNT,
        SUM(CASE WHEN c.STATUS = 'DONE'          THEN 1 ELSE 0 END)               AS DONE_COUNT,
        SUM(CASE WHEN c.STATUS = 'CALLBACK'      THEN 1 ELSE 0 END)               AS CALLBACK_COUNT,
        SUM(CASE WHEN c.STATUS = 'NOT_INTERESTED' THEN 1 ELSE 0 END)              AS NOT_INT_COUNT,
        SUM(CASE WHEN c.STATUS = 'NO_RESPONSE'   THEN 1 ELSE 0 END)               AS NO_RESP_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
         JOIN dbo.[${TABLES.VISITOR_BATCH_CONTACT}] cc ON cc.CONTACT_CODE = l.CONTACT_CODE
         WHERE l.USER_CODE = c.ASSIGNED_TO_USER_CODE AND cc.BATCH_CODE = c.BATCH_CODE) AS LOG_COUNT
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = c.ASSIGNED_TO_USER_CODE
      WHERE c.BATCH_CODE = @batchId AND c.ASSIGNED_TO_USER_CODE IS NOT NULL ${memberScope}
      GROUP BY c.ASSIGNED_TO_USER_CODE, u.USERNAME, c.BATCH_CODE
      ORDER BY ASSIGNED_COUNT DESC;
    `;

    const result = await request.query(q);
    if (!result.recordset[0]) return res.status(404).json({ error: 'Batch not found' });
    res.json({ batch: result.recordsets[0][0], memberStats: result.recordsets[1] });
  } catch (err) {
    console.error('getBatchDetail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getBatchContacts = async (req, res) => {
  try {
    const { batchId } = req.params;
    const {
      page = 1, limit = 50,
      search = '', status = '', assignedTo = '',
      unassignedOnly = 'false',
    } = req.query;

    const pageNum  = parseInt(page, 10)  || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset   = (pageNum - 1) * limitNum;
    const pool     = await poolPromise;
    const request  = pool.request();

    request.input('batchId', sql.VarChar(100), batchId);
    const where = ['c.BATCH_CODE = @batchId'];

    const isHead = isVisitorHead(req);
    if (!isHead) {
      request.input('me', sql.VarChar(100), req.user?.user_code || '');
      where.push('c.ASSIGNED_TO_USER_CODE = @me');
    } else {
      if (assignedTo) {
        request.input('at', sql.VarChar(100), assignedTo);
        where.push('c.ASSIGNED_TO_USER_CODE = @at');
      }
      if (unassignedOnly === 'true') {
        where.push('c.ASSIGNED_TO_USER_CODE IS NULL');
      }
    }

    if (search) {
      request.input('s', sql.NVarChar, `%${search}%`);
      where.push(`(${SEARCH_PERSON_NAME} LIKE @s OR CD.COMPANY_NAME LIKE @s OR CP.MOBILE LIKE @s OR CP.PERSON_EMAIL LIKE @s)`);
    }
    if (status) {
      request.input('st', sql.VarChar(30), status);
      where.push('c.STATUS = @st');
    }

    const whereSQL = 'WHERE ' + where.join(' AND ');

    const q = `
      WITH ContactData AS (
        SELECT c.*,
          ${CONTACT_ALIASES},
          ${PERSON_COLS},
          u.USERNAME AS ASSIGNED_TO_NAME,
          ROW_NUMBER() OVER (ORDER BY c.CONTACT_CODE) AS RowNum
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
        ${PERSON_JOINS}
        LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = c.ASSIGNED_TO_USER_CODE
        ${whereSQL}
      )
      SELECT * FROM ContactData WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      ${PERSON_JOINS}
      ${whereSQL};
    `;

    const result = await request.query(q);
    res.json({
      data:  result.recordsets[0],
      total: result.recordsets[1][0].total,
      page:  pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error('getBatchContacts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.assignContacts = async (req, res) => {
  try {
    const { batchId } = req.params;
    const { contactIds, assignedTo } = req.body;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contacts selected' });
    }
    if (!assignedTo) return res.status(400).json({ error: 'Assignee is required' });

    const assignedBy = req.user?.user_code || 'SYSTEM';
    const pool       = await poolPromise;
    const request    = pool.request();

    request.input('assignedTo', sql.VarChar(100), assignedTo);
    request.input('assignedBy', sql.VarChar(100), assignedBy);
    request.input('batchId',    sql.VarChar(100), batchId);

    const safeIds = contactIds.map(id => String(id)).filter(Boolean);
    if (safeIds.length === 0) return res.status(400).json({ error: 'Invalid contact IDs' });

    const idParams = safeIds.map((id, i) => { request.input(`cid_${i}`, sql.VarChar(100), id); return `@cid_${i}`; });

    const q = `
      UPDATE dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
      SET
        ASSIGNED_TO_USER_CODE = @assignedTo,
        ASSIGNED_BY_USER_CODE = @assignedBy,
        ASSIGNED_DATE         = GETDATE(),
        STATUS = CASE WHEN STATUS = 'NEW' THEN 'ASSIGNED' ELSE STATUS END
      WHERE BATCH_CODE = @batchId
        AND CONTACT_CODE IN (${idParams.join(',')});

      SELECT @@ROWCOUNT AS updated;
    `;

    const result = await request.query(q);
    res.json({ success: true, updated: result.recordset[0].updated });
  } catch (err) {
    console.error('assignContacts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getTeamMembers = async (req, res) => {
  try {
    const pool    = await poolPromise;
    const request = pool.request();
    
    request.input('me', sql.VarChar(100), req.user?.user_code || '');
    const q = `
      SELECT USER_CODE, USERNAME, DEPARTMENT, ACCESS_LEVEL
      FROM dbo.[${TABLES.USER}]
      WHERE ACTIVE = 1 AND (ACCESS_LEVEL IN (5, 6) OR USER_CODE = @me)
      ORDER BY ACCESS_LEVEL, USERNAME;
    `;
    const result = await request.query(q);
    res.json(result.recordset);
  } catch (err) {
    console.error('getTeamMembers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getMyContacts = async (req, res) => {
  try {
    const userCode = req.user?.user_code;
    if (!userCode) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      page = 1,
      limit = 50,
      search = "",
      batchId = "",
      outcome = "",
      worked = "",
      sortBy = "",
      sortDir = ""
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;

    // Sorting — whitelist only; default = most recent activity first.
    const sortExpr = MY_CONTACTS_SORT[sortBy];
    const sortDirSQL = String(sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const orderBySQL = sortExpr
      ? `${sortExpr} ${sortDirSQL}, c.CONTACT_CODE`
      : `ISNULL(LatestLog.CREATED_DATE, c.CREATED_DATE) DESC, c.CONTACT_CODE`;

    const pool = await poolPromise;
    const request = pool.request();

    request.input("uc", sql.VarChar(100), userCode);

    const where = [
      "c.ASSIGNED_TO_USER_CODE = @uc"
    ];

    if (batchId) {
      request.input("bid", sql.VarChar(100), batchId);
      where.push("c.BATCH_CODE = @bid");
    }

    if (outcome) {
      request.input("outcome", sql.VarChar(100), outcome);
      where.push("LatestLog.STATUS = @outcome");
    }

    if (worked === "yes") where.push("LatestLog.STATUS IS NOT NULL");
    else if (worked === "no") where.push("LatestLog.STATUS IS NULL");

    if (search) {
      request.input("s", sql.NVarChar, `%${search}%`);
      where.push(`
        (
          ${SEARCH_PERSON_NAME} LIKE @s
          OR CD.COMPANY_NAME LIKE @s
          OR CP.MOBILE LIKE @s
        )
      `);
    }

    const whereSQL = `WHERE ${where.join(" AND ")}`;

    const q = `
      ;WITH ContactData AS (
        SELECT
          c.CONTACT_CODE,
          c.BATCH_CODE,
          c.PERSON_CODE,
          c.COMPANY_CODE,
          c.ASSIGNED_TO_USER_CODE,
          c.ASSIGNED_DATE,
          c.CREATED_DATE,

          ${CONTACT_ALIASES},
          ${PERSON_COLS},
          CSI.INDUSTRIES AS INDUSTRY,

          b.BATCH_NAME,
          b.BATCH_YEAR,

          LatestLog.STATUS AS CURRENT_STATUS,
          LatestLog.ACTION_TYPE,

          CASE 
            WHEN LatestLog.STATUS = 'Followup'
            THEN LatestLog.NEXT_FOLLOWUP
            ELSE NULL
          END AS NEXT_FOLLOWUP,

          LatestLog.REMARKS AS LAST_REMARK,
          LatestLog.CREATED_DATE AS LAST_ACTIVITY_DATE,

          ROW_NUMBER() OVER (
            ORDER BY ${orderBySQL}
          ) AS RowNum

        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c

        ${PERSON_JOINS}

        LEFT JOIN dbo.[${TABLES.VISITOR_BATCH}] b
          ON b.BATCH_CODE = c.BATCH_CODE

        LEFT JOIN (
          SELECT COMPANY_CODE, STRING_AGG(INDUSTRY, ', ') AS INDUSTRIES
          FROM (
            SELECT DISTINCT m.COMPANY_CODE, s.INDUSTRY
            FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
            JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
          ) x
          GROUP BY COMPANY_CODE
        ) CSI ON CSI.COMPANY_CODE = c.COMPANY_CODE

        OUTER APPLY (
          SELECT TOP 1
            l.STATUS,
            l.ACTION_TYPE,
            l.NEXT_FOLLOWUP,
            l.REMARKS,
            l.CREATED_DATE
          FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
          WHERE l.CONTACT_CODE = c.CONTACT_CODE
          ORDER BY l.CREATED_DATE DESC
        ) LatestLog

        ${whereSQL}
      )

      SELECT *
      FROM ContactData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      ${search ? PERSON_JOINS : ''}
      ${(outcome || worked) ? `OUTER APPLY (
        SELECT TOP 1 l.STATUS
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
        WHERE l.CONTACT_CODE = c.CONTACT_CODE
        ORDER BY l.CREATED_DATE DESC
      ) LatestLog` : ''}
      ${whereSQL};

      SELECT
        b.BATCH_CODE AS BATCH_ID,
        b.BATCH_NAME,
        b.BATCH_YEAR,
        b.CREATED_DATE,
        b.REMARKS,
        COUNT(*) AS TOTAL,
        SUM(CASE WHEN LatestLog.STATUS IS NOT NULL THEN 1 ELSE 0 END) AS WORKED
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      INNER JOIN dbo.[${TABLES.VISITOR_BATCH}] b
        ON b.BATCH_CODE = c.BATCH_CODE
      OUTER APPLY (
        SELECT TOP 1 l.STATUS
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
        WHERE l.CONTACT_CODE = c.CONTACT_CODE
        ORDER BY l.CREATED_DATE DESC
      ) LatestLog
      WHERE
        c.ASSIGNED_TO_USER_CODE = @uc
        AND b.STATUS = 'Y'
      GROUP BY b.BATCH_CODE, b.BATCH_NAME, b.BATCH_YEAR, b.CREATED_DATE, b.REMARKS
      ORDER BY
        b.BATCH_YEAR DESC,
        b.BATCH_NAME;
    `;

    const result = await request.query(q);

    return res.json({
      data: result.recordsets[0] || [],
      total: result.recordsets[1]?.[0]?.total || 0,
      batches: result.recordsets[2] || [],
      page: pageNum,
      limit: limitNum,
    });

  } catch (err) {
    console.error("getMyContacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getFollowups = async (req, res) => {
  try {
    const userCode = req.user?.user_code;
    const level    = Number(req.user?.access_level);
    if (!userCode) return res.status(401).json({ error: 'Unauthorized' });

    const isHead = isVisitorHead(req);
    // source: 'batch' (Internal Leads tab) or 'lead' (External Leads tab) —
    // the two are separate tabs, not a blended default view.
    const { range = 'all', member = '', batchId = '', source = 'batch', search = '', page = 1, limit = 50 } = req.query;
    const pageNum  = parseInt(page, 10)  || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset   = (pageNum - 1) * limitNum;
    const srcFilter = source === 'lead' ? 'LEAD' : 'BATCH';

    const pool    = await poolPromise;
    const request = pool.request();

    // Member scope — used for the batch dropdown (cheap) and the follow-up scan.
    const memberWhere = [];
    if (!isHead)     { request.input('uc', sql.VarChar(100), userCode); memberWhere.push('c.ASSIGNED_TO_USER_CODE = @uc'); }
    else if (member) { request.input('mb', sql.VarChar(100), member);   memberWhere.push('c.ASSIGNED_TO_USER_CODE = @mb'); }
    else             { memberWhere.push('c.ASSIGNED_TO_USER_CODE IS NOT NULL'); }
    const memberSQL = 'WHERE ' + memberWhere.join(' AND ');

    const fuWhere = [...memberWhere];
    if (batchId) { request.input('bid', sql.VarChar(100), batchId);    fuWhere.push('c.BATCH_CODE = @bid'); }
    if (search)  { request.input('s', sql.NVarChar, `%${search}%`);    fuWhere.push(`(${SEARCH_PERSON_NAME} LIKE @s OR CD.COMPANY_NAME LIKE @s OR CP.MOBILE LIKE @s)`); }
    const fuSQL = 'WHERE ' + fuWhere.join(' AND ');

    // Same member/search scope, translated onto the external-lead columns.
    const leadWhere = [];
    if (!isHead)     leadWhere.push('el.ASSIGNED_TO_USER_CODE = @uc');
    else if (member) leadWhere.push('el.ASSIGNED_TO_USER_CODE = @mb');
    else             leadWhere.push('el.ASSIGNED_TO_USER_CODE IS NOT NULL');
    if (search) leadWhere.push('(el.NAME LIKE @s OR el.COMPANY LIKE @s OR el.MOBILE LIKE @s)');
    const leadSQL = 'WHERE ' + leadWhere.join(' AND ');

    let rangeSQL = 'NEXT_FOLLOWUP IS NOT NULL';
    if (range === 'today')         rangeSQL = 'NEXT_FOLLOWUP = CAST(GETDATE() AS DATE)';
    else if (range === 'overdue')  rangeSQL = 'NEXT_FOLLOWUP < CAST(GETDATE() AS DATE)';
    else if (range === 'tomorrow') rangeSQL = 'NEXT_FOLLOWUP = DATEADD(DAY, 1, CAST(GETDATE() AS DATE))';
    else if (range === 'upcoming') rangeSQL = 'NEXT_FOLLOWUP > DATEADD(DAY, 1, CAST(GETDATE() AS DATE))';

    const batchBranch = `
      SELECT
        'BATCH' AS SRC,
        CAST(c.CONTACT_CODE AS NVARCHAR(50)) AS ITEM_ID,
        ${PERSON_COLS},
        CSI.INDUSTRIES AS INDUSTRY,
        b.BATCH_NAME,
        u.USERNAME AS MEMBER_NAME,
        fu.NEXT_FOLLOWUP,
        lo.STATUS AS LAST_OUTCOME
      FROM FU fu
      JOIN dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c ON c.CONTACT_CODE = fu.CONTACT_CODE
        AND fu.rn = 1 AND fu.NEXT_FOLLOWUP IS NOT NULL
      LEFT JOIN LastOutcome lo ON lo.CONTACT_CODE = c.CONTACT_CODE AND lo.rn = 1
      ${PERSON_JOINS}
      LEFT JOIN (
        SELECT COMPANY_CODE, STRING_AGG(INDUSTRY, ', ') AS INDUSTRIES
        FROM (
          SELECT DISTINCT m.COMPANY_CODE, s.INDUSTRY
          FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
          JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
        ) x
        GROUP BY COMPANY_CODE
      ) CSI ON CSI.COMPANY_CODE = c.COMPANY_CODE
      LEFT JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = c.ASSIGNED_TO_USER_CODE
      ${fuSQL}`;

    const leadBranch = `
      SELECT
        'LEAD' AS SRC,
        CAST(el.LEAD_ID AS NVARCHAR(50)) AS ITEM_ID,
        el.NAME AS PERSON_NAME, el.DESIGNATION, el.DEPARTMENT, el.MOBILE, el.EMAIL,
        el.COMPANY AS COMPANY_NAME,
        CAST(NULL AS NVARCHAR(200)) AS DIVISION, CAST(NULL AS NVARCHAR(100)) AS CITY,
        CAST(NULL AS NVARCHAR(100)) AS STATE, CAST(NULL AS NVARCHAR(100)) AS COUNTRY,
        el.INDUSTRY,
        CAST(NULL AS NVARCHAR(200)) AS BATCH_NAME,
        u2.USERNAME AS MEMBER_NAME,
        fl.NEXT_FOLLOWUP,
        lo2.STATUS AS LAST_OUTCOME
      FROM FL fl
      JOIN dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}] el ON el.LEAD_ID = fl.LEAD_ID
        AND fl.rn = 1 AND fl.NEXT_FOLLOWUP IS NOT NULL
      LEFT JOIN LeadLastOutcome lo2 ON lo2.LEAD_ID = el.LEAD_ID AND lo2.rn = 1
      LEFT JOIN dbo.[${TABLES.USER}] u2 ON u2.USER_CODE = el.ASSIGNED_TO_USER_CODE
      ${leadSQL} AND el.PUSHED_BATCH_CODE IS NULL`;

    const q = `
      SELECT DISTINCT b.BATCH_CODE AS BATCH_ID, b.BATCH_NAME, b.BATCH_YEAR
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
      ${memberSQL} AND b.STATUS = 'Y'
      ORDER BY b.BATCH_YEAR DESC, b.BATCH_NAME;

      -- FU/FL rank EVERY log row (not just ones with a follow-up date) so rn=1
      -- is always the truly latest action. A later call logged with no new
      -- date (e.g. "No Answer") must supersede an earlier "Interested +
      -- tomorrow" — filtering to NEXT_FOLLOWUP IS NOT NULL before ranking
      -- would let that stale date keep winning forever. The NULL check moves
      -- to the join below, gating on rn=1's own value instead.
      ;WITH FU AS (
        SELECT CONTACT_CODE, NEXT_FOLLOWUP,
          ROW_NUMBER() OVER (PARTITION BY CONTACT_CODE ORDER BY CREATED_DATE DESC) AS rn
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}]
      ),
      LastOutcome AS (
        SELECT CONTACT_CODE, STATUS,
          ROW_NUMBER() OVER (PARTITION BY CONTACT_CODE ORDER BY CREATED_DATE DESC) AS rn
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}]
        WHERE STATUS IS NOT NULL
      ),
      FL AS (
        SELECT LEAD_ID, NEXT_FOLLOWUP,
          ROW_NUMBER() OVER (PARTITION BY LEAD_ID ORDER BY CREATED_DATE DESC) AS rn
        FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD_LOG}]
      ),
      LeadLastOutcome AS (
        SELECT LEAD_ID, STATUS,
          ROW_NUMBER() OVER (PARTITION BY LEAD_ID ORDER BY CREATED_DATE DESC) AS rn
        FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD_LOG}]
        WHERE STATUS IS NOT NULL
      )
      SELECT * INTO #FU FROM (
        ${batchBranch}
        UNION ALL
        ${leadBranch}
      ) merged;

      SELECT * FROM #FU
      WHERE SRC = @src AND ${rangeSQL}
      ORDER BY NEXT_FOLLOWUP ASC
      OFFSET ${offset} ROWS FETCH NEXT ${limitNum} ROWS ONLY;

      SELECT
        SUM(CASE WHEN NEXT_FOLLOWUP < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN NEXT_FOLLOWUP = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN NEXT_FOLLOWUP = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END) AS tomorrow,
        SUM(CASE WHEN NEXT_FOLLOWUP > DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END) AS upcoming
      FROM #FU WHERE SRC = @src AND NEXT_FOLLOWUP IS NOT NULL;

      -- Tab badge totals — one pending-follow-up count per source, independent
      -- of which tab/range is currently active.
      SELECT SRC, COUNT(*) AS n FROM #FU WHERE NEXT_FOLLOWUP IS NOT NULL GROUP BY SRC;

      DROP TABLE #FU;
    `;

    request.input('src', sql.VarChar(10), srcFilter);

    const result = await request.query(q);
    const counts = result.recordsets[2][0] || { overdue: 0, today: 0, tomorrow: 0, upcoming: 0 };
    const total =
      range === 'today'    ? counts.today :
      range === 'overdue'  ? counts.overdue :
      range === 'tomorrow' ? counts.tomorrow :
      range === 'upcoming' ? counts.upcoming :
      (counts.overdue || 0) + (counts.today || 0) + (counts.tomorrow || 0) + (counts.upcoming || 0);

    const sourceCounts = { batch: 0, lead: 0 };
    result.recordsets[3].forEach(r => { sourceCounts[r.SRC === 'LEAD' ? 'lead' : 'batch'] = r.n; });

    res.json({
      batches: result.recordsets[0],
      data:    result.recordsets[1],
      counts,
      total,
      sourceCounts,
      isHead,
      page:    pageNum,
      limit:   limitNum,
    });
  } catch (err) {
    console.error('getFollowups error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.addContactLog = async (req, res) => {
  try {
    const { contactId } = req.params;
    const { actionType, nextFollowup, remarks, newStatus, callId, callStatus, callDuration } = req.body;

    const userCode = req.user?.user_code || 'SYSTEM';
    const userName = req.user?.username  || '';
    const pool     = await poolPromise;
    const request  = pool.request();

    request.input('contactId',  sql.VarChar(100),  contactId);
    request.input('actionType', sql.VarChar(100),   actionType  || null);
    request.input('nextFU',     sql.Date,          nextFollowup || null);
    request.input('remarks',    sql.NVarChar(1000), remarks    || null);
    request.input('userCode',   sql.VarChar(100),  userCode);
    request.input('userName',   sql.NVarChar(200), userName);
    request.input('newStatus', sql.VarChar(100), newStatus);
    request.input('callId',       sql.VarChar(100), callId || null);
    request.input('callStatus',   sql.VarChar(30),  callStatus || null);
    request.input('callDuration', sql.Int,          Number.isInteger(callDuration) ? callDuration : null);

    if (nextFollowup) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (String(nextFollowup).split('T')[0] <= todayStr) {
        return res.status(400).json({ error: 'Follow-up date must be after today.' });
      }
      const cntReq = pool.request();
      cntReq.input('contactId', sql.VarChar(100), contactId);
      const cnt = await cntReq.query(`
        SELECT COUNT(*) AS n
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}]
        WHERE CONTACT_CODE = @contactId AND NEXT_FOLLOWUP >= CAST(GETDATE() AS DATE);
      `);
      if ((cnt.recordset[0]?.n || 0) >= 5) {
        return res.status(400).json({ error: 'This contact already has 5 pending follow-ups.' });
      }
    }

    const q = `
      INSERT INTO dbo.[${TABLES.VISITOR_CONTACT_LOG}]
        (LOG_ID, CONTACT_CODE, ACTION_TYPE, STATUS, NEXT_FOLLOWUP, REMARKS, USER_CODE, USER_NAME, CREATED_DATE, CALL_ID, CALL_STATUS, CALL_DURATION)
      VALUES
        (CONVERT(VARCHAR(36), NEWID()), @contactId, @actionType, @newStatus, @nextFU, @remarks, @userCode, @userName, GETDATE(), @callId, @callStatus, @callDuration);

      SELECT c.*, ${CONTACT_ALIASES}, ${PERSON_COLS}, b.BATCH_NAME
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      ${PERSON_JOINS}
      LEFT JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
      WHERE c.CONTACT_CODE = @contactId;
    `;

    const result = await request.query(q);
    res.json({ success: true, contact: result.recordset[0] });
  } catch (err) {
    console.error('addContactLog error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getContactLogs = async (req, res) => {
  try {
    const { contactId } = req.params;
    const pool    = await poolPromise;
    const request = pool.request();
    request.input('contactId', sql.VarChar(100), contactId);

    const q = `
      SELECT l.*,
        l.USER_CODE AS DONE_BY,
        l.USER_NAME AS DONE_BY_NAME
      FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
      WHERE l.CONTACT_CODE = @contactId
      ORDER BY l.CREATED_DATE DESC;
    `;

    const result = await request.query(q);
    res.json(result.recordset);
  } catch (err) {
    console.error('getContactLogs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateBatchStatus = async (req, res) => {
  try {
    const { batchId } = req.params;
    const { status }  = req.body;
    if (!['Y','N'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const pool    = await poolPromise;
    const request = pool.request();
    request.input('batchId', sql.VarChar(100), batchId);
    request.input('status',  sql.VarChar(10),  status);

    await request.query(`
      UPDATE dbo.[${TABLES.VISITOR_BATCH}]
      SET STATUS = @status, UPDATED_DATE = GETDATE()
      WHERE BATCH_CODE = @batchId;
    `);
    res.json({ success: true });
  } catch (err) {
    console.error('updateBatchStatus error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.smartAssign = async (req, res) => {
  try {
    const { batchId }                      = req.params;
    const { mode, assignTo, count, members } = req.body;
    const assignedBy = req.user?.user_code || 'SYSTEM';
    const pool       = await poolPromise;
    const request    = pool.request();

    request.input('batchId',    sql.VarChar(100), batchId);
    request.input('assignedBy', sql.VarChar(100), assignedBy);

    let q = '';

    if (mode === 'count') {
      // Assign next N unassigned contacts to one member
      if (!assignTo || !count) return res.status(400).json({ error: 'assignTo and count required' });
      const n = parseInt(count, 10);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: 'count must be a positive number' });
      request.input('assignTo', sql.VarChar(100), assignTo);
      request.input('countN',   sql.Int,          n);
      q = `
        WITH ToUpdate AS (
          SELECT TOP (@countN) CONTACT_CODE
          FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
          WHERE BATCH_CODE = @batchId AND ASSIGNED_TO_USER_CODE IS NULL
          ORDER BY CONTACT_CODE
        )
        UPDATE dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
        SET ASSIGNED_TO_USER_CODE = @assignTo,
            ASSIGNED_BY_USER_CODE = @assignedBy,
            ASSIGNED_DATE         = GETDATE(),
            STATUS                = 'ASSIGNED'
        WHERE CONTACT_CODE IN (SELECT CONTACT_CODE FROM ToUpdate);
        SELECT @@ROWCOUNT AS updated;
      `;

    } else if (mode === 'distribute') {
      // Each member gets a specified count from unassigned pool
      if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'members array required' });
      let offset = 0;
      const cases = [];
      members.forEach((m, i) => {
        const cnt = parseInt(m.count, 10);
        if (!cnt || cnt < 1) return;
        request.input(`dm_${i}`, sql.VarChar(100), m.userCode);
        request.input(`ds_${i}`, sql.Int,          offset + 1);
        request.input(`de_${i}`, sql.Int,          offset + cnt);
        cases.push(`WHEN ur.rn BETWEEN @ds_${i} AND @de_${i} THEN @dm_${i}`);
        offset += cnt;
      });
      if (cases.length === 0) return res.status(400).json({ error: 'No valid member counts provided' });
      request.input('totalRows', sql.Int, offset);
      q = `
        WITH UnassignedRanked AS (
          SELECT CONTACT_CODE,
            ROW_NUMBER() OVER (ORDER BY CONTACT_CODE) AS rn
          FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
          WHERE BATCH_CODE = @batchId AND ASSIGNED_TO_USER_CODE IS NULL
        )
        UPDATE c
        SET c.ASSIGNED_TO_USER_CODE = CASE ${cases.join(' ')} END,
            c.ASSIGNED_BY_USER_CODE = @assignedBy,
            c.ASSIGNED_DATE         = GETDATE(),
            c.STATUS                = 'ASSIGNED'
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
        JOIN UnassignedRanked ur ON ur.CONTACT_CODE = c.CONTACT_CODE
        WHERE ur.rn <= @totalRows;
        SELECT @@ROWCOUNT AS updated;
      `;

    } else if (mode === 'even') {
      // Divide ALL unassigned evenly among given members
      if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'members array required' });
      const memberCodes = members.filter(Boolean);
      const mCount      = memberCodes.length;
      request.input('mCount', sql.Int, mCount);
      memberCodes.forEach((code, i) => request.input(`em_${i}`, sql.VarChar(100), code));
      const memberCase = memberCodes
        .map((_, i) => `WHEN ((ur.rn - 1) % @mCount) = ${i} THEN @em_${i}`)
        .join(' ');
      q = `
        WITH UnassignedRanked AS (
          SELECT CONTACT_CODE,
            ROW_NUMBER() OVER (ORDER BY CONTACT_CODE) AS rn
          FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
          WHERE BATCH_CODE = @batchId AND ASSIGNED_TO_USER_CODE IS NULL
        )
        UPDATE c
        SET c.ASSIGNED_TO_USER_CODE = CASE ${memberCase} END,
            c.ASSIGNED_BY_USER_CODE = @assignedBy,
            c.ASSIGNED_DATE         = GETDATE(),
            c.STATUS                = 'ASSIGNED'
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
        JOIN UnassignedRanked ur ON ur.CONTACT_CODE = c.CONTACT_CODE;
        SELECT @@ROWCOUNT AS updated;
      `;

    } else {
      return res.status(400).json({ error: 'Invalid mode. Use count | distribute | even' });
    }

    const result = await request.query(q);
    res.json({ success: true, updated: result.recordset[0].updated });
  } catch (err) {
    console.error('smartAssign error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Move a member's contacts in a batch to another team member.
// Body: { fromUser, toUser, count? }  — count omitted/0 => reassign all.
exports.reassignContacts = async (req, res) => {
  try {
    const { batchId }                  = req.params;
    const { fromUser, toUser, count }  = req.body;

    if (!fromUser || !toUser) return res.status(400).json({ error: 'fromUser and toUser are required' });
    if (fromUser === toUser)  return res.status(400).json({ error: 'Cannot reassign to the same member' });

    const assignedBy = req.user?.user_code || 'SYSTEM';
    const pool       = await poolPromise;
    const request    = pool.request();

    request.input('batchId',    sql.VarChar(100), batchId);
    request.input('fromUser',   sql.VarChar(100), fromUser);
    request.input('toUser',     sql.VarChar(100), toUser);
    request.input('assignedBy', sql.VarChar(100), assignedBy);

    // TOP filter only when a positive count is supplied; otherwise move all.
    let topClause = '';
    const n = parseInt(count, 10);
    if (!isNaN(n) && n > 0) {
      request.input('countN', sql.Int, n);
      topClause = 'TOP (@countN) ';
    }

    const q = `
      WITH ToMove AS (
        SELECT ${topClause}CONTACT_CODE
        FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
        WHERE BATCH_CODE = @batchId AND ASSIGNED_TO_USER_CODE = @fromUser
        ORDER BY CONTACT_CODE
      )
      UPDATE dbo.[${TABLES.VISITOR_BATCH_CONTACT}]
      SET ASSIGNED_TO_USER_CODE = @toUser,
          ASSIGNED_BY_USER_CODE = @assignedBy,
          ASSIGNED_DATE         = GETDATE()
      WHERE CONTACT_CODE IN (SELECT CONTACT_CODE FROM ToMove);
      SELECT @@ROWCOUNT AS updated;
    `;

    const result = await request.query(q);
    res.json({ success: true, updated: result.recordset[0].updated });
  } catch (err) {
    console.error('reassignContacts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Analytics ────────────────────────────────────────────────────────────────
// Accurate call outcomes live in VISITOR_CONTACT_LOG.STATUS (the latest log per
// contact). VISITOR_BATCH_CONTACT.STATUS is a coarse pipeline state that the call
// panel never updates, so every outcome number below is derived from the latest
// log. Time-based activity comes from VISITOR_CONTACT_LOG.CREATED_DATE.

// The 13 outcomes a contact can end on (mirror of frontend CALL_OUTCOMES).
const OUTCOME_KEYS = [
  'Interested', 'Not_Interested', 'Ringing', 'Busy', 'Switched_Off',
  'Out_of_Network', 'No_Incoming', 'No_Number', 'Foreign_Number',
  'Wrong_Number', 'Invalid', 'Out_of_Service', 'Followup',
];
// "Number never reached the person" bucket — handy as a single trend series.
const NOT_CONNECTED_SQL = `'Wrong_Number','No_Number','Invalid','Foreign_Number','Switched_Off','Out_of_Network','Out_of_Service','No_Incoming'`;

// WHERE conditions scoping a VISITOR_BATCH_CONTACT alias to batch/year.
function analyticsScope(alias, { batchId, year }) {
  const conds = [];
  if (batchId) conds.push(`${alias}.BATCH_CODE = @bid`);
  if (year)    conds.push(`${alias}.BATCH_CODE IN (SELECT BATCH_CODE FROM dbo.[${TABLES.VISITOR_BATCH}] WHERE BATCH_YEAR = @yr)`);
  return conds.length ? conds.join(' AND ') : '1=1';
}

// SQL expression that buckets a datetime column by the chosen granularity.
function bucketExpr(granularity, col) {
  if (granularity === 'month') return `DATEFROMPARTS(YEAR(${col}), MONTH(${col}), 1)`;
  if (granularity === 'week')  return `DATEADD(DAY, 1 - DATEPART(WEEKDAY, ${col}), CAST(${col} AS DATE))`;
  return `CAST(${col} AS DATE)`; // day
}

const ymd = (d) => d.toISOString().slice(0, 10);

const analyticsCache = createTtlCache(20000);

exports.getAnalytics = async (req, res) => {
  try {
    const { batchId, year } = req.query;
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';

    // Date range — default last 30 days. Previous window = same length, immediately before.
    const today = new Date();
    const to    = req.query.to   ? new Date(req.query.to)   : today;
    const from  = req.query.from ? new Date(req.query.from) : new Date(today.getTime() - 29 * 86400000);
    const spanMs   = Math.max(0, to.getTime() - from.getTime());
    const prevTo   = new Date(from.getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - spanMs);

    const cacheKey = JSON.stringify({ b: batchId || '', y: year || '', g: granularity, f: ymd(from), t: ymd(to) });
    const payload = await analyticsCache(cacheKey, async () => {
    const pool    = await poolPromise;
    const request = pool.request();
    if (batchId) request.input('bid', sql.VarChar(100), batchId);
    if (year)    request.input('yr',  sql.Int, parseInt(year, 10));
    request.input('from',     sql.Date, ymd(from));
    request.input('to',       sql.Date, ymd(to));
    request.input('prevFrom', sql.Date, ymd(prevFrom));
    request.input('prevTo',   sql.Date, ymd(prevTo));

    const scopeC  = analyticsScope('c', { batchId, year });
    const bucketL = bucketExpr(granularity, 'l.CREATED_DATE');

    const q = `
      -- Latest-log outcome per contact, computed once from the (small) log table and
      -- joined to the scoped contacts — avoids a per-contact correlated seek over 90k rows.
      ;WITH LatestLog AS (
        SELECT l.CONTACT_CODE, l.STATUS,
          ROW_NUMBER() OVER (PARTITION BY l.CONTACT_CODE ORDER BY l.CREATED_DATE DESC) AS rn
        FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
      )
      SELECT c.CONTACT_CODE, c.BATCH_CODE, c.ASSIGNED_TO_USER_CODE, ll.STATUS AS OUTCOME
      INTO #C
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      LEFT JOIN LatestLog ll ON ll.CONTACT_CODE = c.CONTACT_CODE AND ll.rn = 1
      WHERE ${scopeC};

      -- 1. Overview (state)
      SELECT
        COUNT(*)                                                          AS total,
        SUM(CASE WHEN ASSIGNED_TO_USER_CODE IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
        SUM(CASE WHEN ASSIGNED_TO_USER_CODE IS NULL     THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN OUTCOME IS NOT NULL               THEN 1 ELSE 0 END) AS worked,
        SUM(CASE WHEN OUTCOME = 'Interested'            THEN 1 ELSE 0 END) AS interested,
        SUM(CASE WHEN OUTCOME = 'Not_Interested'        THEN 1 ELSE 0 END) AS not_interested,
        SUM(CASE WHEN OUTCOME = 'Followup'              THEN 1 ELSE 0 END) AS followup,
        SUM(CASE WHEN OUTCOME IN (${NOT_CONNECTED_SQL}) THEN 1 ELSE 0 END) AS not_connected
      FROM #C;

      -- 2. Outcome breakdown (latest log per contact)
      SELECT ISNULL(OUTCOME, 'Pending') AS outcome, COUNT(*) AS cnt
      FROM #C
      GROUP BY ISNULL(OUTCOME, 'Pending');

      -- 3. Team performance (state + range/today activity)
      SELECT
        c.ASSIGNED_TO_USER_CODE                                          AS ASSIGNED_TO,
        ISNULL(u.USERNAME, c.ASSIGNED_TO_USER_CODE)                      AS MEMBER_NAME,
        COUNT(*)                                                          AS ASSIGNED_COUNT,
        SUM(CASE WHEN c.OUTCOME IS NOT NULL THEN 1 ELSE 0 END)           AS WORKED_COUNT,
        SUM(CASE WHEN c.OUTCOME = 'Interested'     THEN 1 ELSE 0 END)    AS INTERESTED_COUNT,
        SUM(CASE WHEN c.OUTCOME = 'Not_Interested' THEN 1 ELSE 0 END)    AS NOT_INT_COUNT,
        SUM(CASE WHEN c.OUTCOME = 'Ringing'        THEN 1 ELSE 0 END)    AS RINGING_COUNT,
        SUM(CASE WHEN c.OUTCOME = 'Busy'           THEN 1 ELSE 0 END)    AS BUSY_COUNT,
        SUM(CASE WHEN c.OUTCOME = 'Followup'       THEN 1 ELSE 0 END)    AS FOLLOWUP_COUNT,
        SUM(CASE WHEN c.OUTCOME IN (${NOT_CONNECTED_SQL}) THEN 1 ELSE 0 END) AS NOT_CONNECTED_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
           JOIN #C cc ON cc.CONTACT_CODE = l.CONTACT_CODE
           WHERE l.USER_CODE = c.ASSIGNED_TO_USER_CODE
             AND CAST(l.CREATED_DATE AS DATE) BETWEEN @from AND @to)     AS RANGE_CALLS,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
           WHERE l.USER_CODE = c.ASSIGNED_TO_USER_CODE
             AND CAST(l.CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE)) AS TODAY_LOGS
      FROM #C c
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = c.ASSIGNED_TO_USER_CODE
      WHERE c.ASSIGNED_TO_USER_CODE IS NOT NULL
      GROUP BY c.ASSIGNED_TO_USER_CODE, u.USERNAME
      ORDER BY ASSIGNED_COUNT DESC;

      -- 4. Batch-wise activity (state)
      SELECT
        c.BATCH_CODE AS BATCH_ID, b.BATCH_NAME, b.BATCH_YEAR, b.TOTAL_CONTACTS,
        ISNULL(u.USERNAME, b.USER_CODE) AS ASSIGNED_TO_NAME,
        COUNT(*)                                                          AS STAT_TOTAL,
        SUM(CASE WHEN c.ASSIGNED_TO_USER_CODE IS NOT NULL THEN 1 ELSE 0 END) AS STAT_ASSIGNED,
        SUM(CASE WHEN c.OUTCOME IS NOT NULL           THEN 1 ELSE 0 END) AS STAT_WORKED,
        SUM(CASE WHEN c.OUTCOME = 'Interested'        THEN 1 ELSE 0 END) AS STAT_INTERESTED,
        SUM(CASE WHEN c.OUTCOME = 'Followup'          THEN 1 ELSE 0 END) AS STAT_FOLLOWUP
      FROM #C c
      JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = b.USER_CODE
      GROUP BY c.BATCH_CODE, b.BATCH_NAME, b.BATCH_YEAR, b.TOTAL_CONTACTS, u.USERNAME, b.USER_CODE, b.CREATED_DATE
      ORDER BY b.CREATED_DATE DESC;

      -- 5. Activity time-series (logs in range, bucketed by granularity)
      SELECT
        ${bucketL} AS bucket,
        COUNT(*)                                                          AS totalCalls,
        SUM(CASE WHEN l.STATUS = 'Interested'     THEN 1 ELSE 0 END)      AS interested,
        SUM(CASE WHEN l.STATUS = 'Not_Interested' THEN 1 ELSE 0 END)      AS notInterested,
        SUM(CASE WHEN l.STATUS = 'Followup'       THEN 1 ELSE 0 END)      AS followup,
        SUM(CASE WHEN l.STATUS IN (${NOT_CONNECTED_SQL}) THEN 1 ELSE 0 END) AS notConnected
      FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
      JOIN #C c ON c.CONTACT_CODE = l.CONTACT_CODE
      WHERE CAST(l.CREATED_DATE AS DATE) BETWEEN @from AND @to
      GROUP BY ${bucketL}
      ORDER BY bucket;

      -- 6. Per-member activity series (for sparklines)
      SELECT l.USER_CODE AS ASSIGNED_TO, ${bucketL} AS bucket, COUNT(*) AS cnt
      FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
      JOIN #C c ON c.CONTACT_CODE = l.CONTACT_CODE
      WHERE CAST(l.CREATED_DATE AS DATE) BETWEEN @from AND @to AND l.USER_CODE IS NOT NULL
      GROUP BY l.USER_CODE, ${bucketL};

      -- 7. Activity KPIs (range vs previous period vs today)
      SELECT
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l JOIN #C c ON c.CONTACT_CODE = l.CONTACT_CODE
           WHERE CAST(l.CREATED_DATE AS DATE) BETWEEN @from AND @to)         AS rangeCalls,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l JOIN #C c ON c.CONTACT_CODE = l.CONTACT_CODE
           WHERE CAST(l.CREATED_DATE AS DATE) BETWEEN @prevFrom AND @prevTo) AS prevCalls,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l JOIN #C c ON c.CONTACT_CODE = l.CONTACT_CODE
           WHERE CAST(l.CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE))     AS todayCalls;

      -- 8. Filter options
      SELECT DISTINCT BATCH_YEAR AS year FROM dbo.[${TABLES.VISITOR_BATCH}] ORDER BY year DESC;
      SELECT BATCH_CODE AS BATCH_ID, BATCH_NAME, BATCH_YEAR
      FROM dbo.[${TABLES.VISITOR_BATCH}] WHERE STATUS = 'Y'
      ORDER BY BATCH_YEAR DESC, BATCH_NAME;

      DROP TABLE #C;
    `;

    const r = await request.query(q);

    // Zero-fill the outcome breakdown so every known outcome appears.
    const rawOutcomes = Object.fromEntries(r.recordsets[1].map(x => [x.outcome, x.cnt]));
    const outcomeBreakdown = OUTCOME_KEYS.map(k => ({ key: k, count: rawOutcomes[k] || 0 }));
    const pending = rawOutcomes['Pending'] || 0;

    return {
      filters: { batchId: batchId || null, year: year || null, granularity, from: ymd(from), to: ymd(to) },
      overview: r.recordsets[0][0],
      outcomeBreakdown,
      pending,
      members: r.recordsets[2],
      batches: r.recordsets[3],
      timeseries: r.recordsets[4],
      memberSeries: r.recordsets[5],
      activity: r.recordsets[6][0],
      years: r.recordsets[7].map(x => x.year),
      batchOptions: r.recordsets[8],
    };
    });

    res.json(payload);
  } catch (err) {
    console.error('getAnalytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const { batchId, year } = req.query;
    const pool    = await poolPromise;
    const request = pool.request();

    const bWhere = ["b.STATUS = 'Y'"];
    const cWhere = ['1=1'];
    if (batchId) { request.input('bid', sql.VarChar(100), batchId); bWhere.push('b.BATCH_CODE = @bid'); cWhere.push('c.BATCH_CODE = @bid'); }
    if (year)    { request.input('yr',  sql.Int, parseInt(year));   bWhere.push('b.BATCH_YEAR = @yr'); cWhere.push(`c.BATCH_CODE IN (SELECT BATCH_CODE FROM dbo.[${TABLES.VISITOR_BATCH}] WHERE BATCH_YEAR = @yr)`); }
    const batchWhereSQL   = 'WHERE ' + bWhere.join(' AND ');
    const contactWhereSQL = 'WHERE ' + cWhere.join(' AND ');

    const q = `
      -- 1. Overall contact stats
      SELECT
        COUNT(*)                                                                  AS total,
        SUM(CASE WHEN c.ASSIGNED_TO_USER_CODE IS NOT NULL THEN 1 ELSE 0 END)    AS assigned,
        SUM(CASE WHEN c.ASSIGNED_TO_USER_CODE IS NULL     THEN 1 ELSE 0 END)    AS unassigned,
        SUM(CASE WHEN c.STATUS = 'WORKING'         THEN 1 ELSE 0 END)          AS working,
        SUM(CASE WHEN c.STATUS = 'INTERESTED'      THEN 1 ELSE 0 END)          AS interested,
        SUM(CASE WHEN c.STATUS = 'NOT_INTERESTED'  THEN 1 ELSE 0 END)          AS not_interested,
        SUM(CASE WHEN c.STATUS = 'CALLBACK'        THEN 1 ELSE 0 END)          AS callback,
        SUM(CASE WHEN c.STATUS = 'NO_RESPONSE'     THEN 1 ELSE 0 END)          AS no_response,
        SUM(CASE WHEN c.STATUS = 'DONE'            THEN 1 ELSE 0 END)          AS done,
        SUM(CASE WHEN c.STATUS NOT IN ('NEW','ASSIGNED') THEN 1 ELSE 0 END)    AS worked
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      ${contactWhereSQL};

      -- 2. Per-member performance
      SELECT
        c.ASSIGNED_TO_USER_CODE AS ASSIGNED_TO,
        u.USERNAME                                                              AS MEMBER_NAME,
        COUNT(*)                                                                AS ASSIGNED_COUNT,
        SUM(CASE WHEN c.STATUS NOT IN ('NEW','ASSIGNED') THEN 1 ELSE 0 END)    AS WORKED_COUNT,
        SUM(CASE WHEN c.STATUS = 'INTERESTED'    THEN 1 ELSE 0 END)            AS INTERESTED_COUNT,
        SUM(CASE WHEN c.STATUS = 'DONE'          THEN 1 ELSE 0 END)            AS DONE_COUNT,
        SUM(CASE WHEN c.STATUS = 'CALLBACK'      THEN 1 ELSE 0 END)            AS CALLBACK_COUNT,
        SUM(CASE WHEN c.STATUS = 'NOT_INTERESTED' THEN 1 ELSE 0 END)           AS NOT_INT_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l WHERE l.USER_CODE = c.ASSIGNED_TO_USER_CODE) AS LOG_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l WHERE l.USER_CODE = c.ASSIGNED_TO_USER_CODE AND CAST(l.CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE)) AS TODAY_LOGS
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = c.ASSIGNED_TO_USER_CODE
      ${contactWhereSQL.replace('1=1','c.ASSIGNED_TO_USER_CODE IS NOT NULL')}
      GROUP BY c.ASSIGNED_TO_USER_CODE, u.USERNAME
      ORDER BY WORKED_COUNT DESC;

      -- 3. Overdue callbacks count
      SELECT COUNT(DISTINCT c.CONTACT_CODE) AS overdue
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      WHERE c.STATUS = 'CALLBACK'
        AND EXISTS (
          SELECT 1 FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
          WHERE l.CONTACT_CODE = c.CONTACT_CODE
            AND l.NEXT_FOLLOWUP < CAST(GETDATE() AS DATE)
        )
        ${batchId ? 'AND c.BATCH_CODE = @bid' : ''};

      -- 4. Today's activity count
      SELECT COUNT(*) AS today_logs
      FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}]
      WHERE CAST(CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE);

      -- 5. Status breakdown for chart
      SELECT STATUS, COUNT(*) AS cnt
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      ${contactWhereSQL}
      GROUP BY STATUS
      ORDER BY cnt DESC;

      -- 6. Active batches summary (top 8 most recent)
      SELECT TOP 8 b.BATCH_CODE AS BATCH_ID, b.BATCH_NAME, b.BATCH_YEAR, b.TOTAL_CONTACTS,
        b.USER_CODE AS ASSIGNED_TO,
        u.USERNAME AS ASSIGNED_TO_NAME,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] WHERE BATCH_CODE=b.BATCH_CODE AND ASSIGNED_TO_USER_CODE IS NOT NULL) AS ASSIGNED_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] WHERE BATCH_CODE=b.BATCH_CODE AND STATUS='DONE')                     AS DONE_COUNT,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] WHERE BATCH_CODE=b.BATCH_CODE AND STATUS='INTERESTED')               AS INTERESTED_COUNT
      FROM dbo.[${TABLES.VISITOR_BATCH}] b
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = b.USER_CODE
      ${batchWhereSQL}
      ORDER BY b.CREATED_DATE DESC;

      -- 7. Available years for filter
      SELECT DISTINCT BATCH_YEAR AS year FROM dbo.[${TABLES.VISITOR_BATCH}] ORDER BY BATCH_YEAR DESC;
    `;

    const result = await request.query(q);
    res.json({
      overview:     result.recordsets[0][0],
      members:      result.recordsets[1],
      overdue:      result.recordsets[2][0]?.overdue || 0,
      todayLogs:    result.recordsets[3][0]?.today_logs || 0,
      statusBreak:  result.recordsets[4],
      batches:      result.recordsets[5],
      years:        result.recordsets[6].map(r => r.year),
    });
  } catch (err) {
    console.error('getDashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

function reportRangeBounds(range) {
  const now = new Date();
  if (range === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from); to.setDate(to.getDate() + 1);
    return { from, to };
  }
  if (range === 'week') {
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate()); to.setDate(to.getDate() + 1);
    const from = new Date(to); from.setDate(from.getDate() - 7);
    return { from, to };
  }
  if (range === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from, to };
  }
  return { from: null, to: null };
}

exports.getMyStats = async (req, res) => {
  try {
    const userCode = req.user?.user_code;
    if (!userCode) return res.status(401).json({ error: 'Unauthorized' });

    const range = String(req.query.range || 'all').toLowerCase();
    const { from, to } = reportRangeBounds(range);

    const pool = await poolPromise;
    const request = pool.request();
    request.input('me', sql.VarChar(100), userCode);
    if (from && to) {
      request.input('from', sql.DateTime, from);
      request.input('to', sql.DateTime, to);
    }
    const bcDateFilter = from && to ? 'AND l.CREATED_DATE >= @from AND l.CREATED_DATE < @to' : '';
    const elDateFilter = from && to ? 'AND ll.CREATED_DATE >= @from AND ll.CREATED_DATE < @to' : '';
    // "Assigned" is a lifetime count by default; scoped to the period only
    // when a range is picked, so "Today" can answer "what landed on my plate today".
    const bcAssignedFilter = from && to ? 'AND c.ASSIGNED_DATE >= @from AND c.ASSIGNED_DATE < @to' : '';
    const elAssignedFilter = from && to ? 'AND el.ASSIGNED_DATE >= @from AND el.ASSIGNED_DATE < @to' : '';

    const q = `
      SELECT c.CONTACT_CODE, LatestLog.STATUS
      INTO #BC
      FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
      INNER JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
      OUTER APPLY (
        SELECT TOP 1 l.STATUS FROM dbo.[${TABLES.VISITOR_CONTACT_LOG}] l
        WHERE l.CONTACT_CODE = c.CONTACT_CODE ${bcDateFilter} ORDER BY l.CREATED_DATE DESC
      ) LatestLog
      WHERE c.ASSIGNED_TO_USER_CODE = @me AND b.STATUS = 'Y';

      SELECT el.LEAD_ID, LatestLog.STATUS
      INTO #EL
      FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}] el
      OUTER APPLY (
        SELECT TOP 1 ll.STATUS FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD_LOG}] ll
        WHERE ll.LEAD_ID = el.LEAD_ID ${elDateFilter} ORDER BY ll.CREATED_DATE DESC
      ) LatestLog
      WHERE el.ASSIGNED_TO_USER_CODE = @me AND el.PUSHED_BATCH_CODE IS NULL;

      SELECT
        (SELECT COUNT(*) FROM #BC) AS batchTotal,
        (SELECT COUNT(*) FROM #BC WHERE STATUS IS NOT NULL) AS batchWorked,
        (SELECT COUNT(*) FROM #EL) AS leadTotal,
        (SELECT COUNT(*) FROM #EL WHERE STATUS IS NOT NULL) AS leadWorked,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_BATCH_CONTACT}] c
           INNER JOIN dbo.[${TABLES.VISITOR_BATCH}] b ON b.BATCH_CODE = c.BATCH_CODE
           WHERE c.ASSIGNED_TO_USER_CODE = @me AND b.STATUS = 'Y' ${bcAssignedFilter}) AS batchAssigned,
        (SELECT COUNT(*) FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}] el
           WHERE el.ASSIGNED_TO_USER_CODE = @me AND el.PUSHED_BATCH_CODE IS NULL ${elAssignedFilter}) AS leadAssigned;

      SELECT STATUS, COUNT(*) AS n FROM (
        SELECT STATUS FROM #BC WHERE STATUS IS NOT NULL
        UNION ALL
        SELECT STATUS FROM #EL WHERE STATUS IS NOT NULL
      ) x GROUP BY STATUS;

      DROP TABLE #BC;
      DROP TABLE #EL;
    `;

    const result = await request.query(q);
    const overview = result.recordsets[0][0] || {};
    const outcomeBreak = {};
    result.recordsets[1].forEach((r) => { outcomeBreak[r.STATUS] = r.n; });

    const batchTotal = overview.batchTotal || 0;
    const batchWorked = overview.batchWorked || 0;
    const leadTotal = overview.leadTotal || 0;
    const leadWorked = overview.leadWorked || 0;
    const batchAssigned = overview.batchAssigned || 0;
    const leadAssigned = overview.leadAssigned || 0;

    res.json({
      range,
      batch: { total: batchTotal, assigned: batchAssigned, worked: batchWorked, pending: batchTotal - batchWorked },
      lead: { total: leadTotal, assigned: leadAssigned, worked: leadWorked, pending: leadTotal - leadWorked },
      overall: {
        total: batchTotal + leadTotal,
        assigned: batchAssigned + leadAssigned,
        worked: batchWorked + leadWorked,
        pending: (batchTotal + leadTotal) - (batchWorked + leadWorked),
      },
      outcomeBreak,
    });
  } catch (err) {
    console.error('getMyStats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getTelecmiCredentials = async (req, res) => {
  try {
    const userCode = req.user?.user_code;
    if (!userCode) return res.status(401).json({ error: 'Unauthorized' });

    const pool = await poolPromise;
    const result = await pool.request()
      .input('uc', sql.VarChar(100), userCode)
      .query(`
        SELECT TELECMI_USER_ID, TELECMI_PASSWORD
        FROM dbo.[${TABLES.USER}]
        WHERE USER_CODE = @uc
      `);

    const row = result.recordset[0];
    if (!row || !row.TELECMI_USER_ID || !row.TELECMI_PASSWORD) {
      return res.status(404).json({ error: 'Calling is not set up for your account yet. Ask an admin to add your TeleCMI login.' });
    }

    res.json({
      userId: row.TELECMI_USER_ID,
      password: row.TELECMI_PASSWORD,
      sbcUri: process.env.TELECMI_SBC_URI || '',
    });
  } catch (err) {
    console.error('getTelecmiCredentials error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
