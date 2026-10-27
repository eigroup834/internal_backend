const { poolPromise, sql } = require('../db');
const { TABLES } = require('../helper');
const ExcelJS = require('exceljs');

const columns = [
  ['Contact', 'NAME', 24], ['Company', 'COMPANY', 30],
  ['Designation', 'DESIGNATION', 24], ['Department', 'DEPARTMENT', 22],
  ['Mobile', 'MOBILE', 20], ['Email', 'EMAIL', 30],
  ['Industry', 'INDUSTRY', 26], ['City', 'CITY', 20],
  ['Event', 'EVENT_NAME', 28], ['Category', 'CATEGORY', 18],
  ['Assigned Person', 'ASSIGNED_PERSON_NAME', 24], ['Assigned To', 'ASSIGNED_TO_NAME', 24],
  ['Registered Date', 'REGISTERED_DATE', 22],
];

exports.list = async (req, res) => {
  try {
    const download = req.path.endsWith('/download');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 50;
    const search = String(req.query.search || '').trim();
    const pool = await poolPromise;
    const request = pool.request();
    const where = ["l.SOURCE_NAME = 'EXHIBITOR_TURNED_VISITOR'"];
    if (search) {
      request.input('search', sql.NVarChar, '%' + search + '%');
      where.push('(l.NAME LIKE @search OR l.COMPANY LIKE @search OR l.EMAIL LIKE @search OR l.MOBILE LIKE @search OR l.EVENT_NAME LIKE @search)');
    }
    const whereSQL = 'WHERE ' + where.join(' AND ');
    if (!download) {
      request.input('offset', sql.Int, (page - 1) * limit);
      request.input('limit', sql.Int, limit);
    }
    const result = await request.query(`
      SELECT l.LEAD_ID, l.NAME, l.COMPANY, l.DESIGNATION, l.DEPARTMENT,
        l.MOBILE, l.EMAIL, l.INDUSTRY, l.CITY, l.EVENT_NAME, l.CATEGORY, l.REGISTERED_DATE,
        COALESCE(JSON_VALUE(CASE WHEN ISJSON(l.RAW_JSON) = 1 THEN l.RAW_JSON ELSE N'{}' END, '$.assignedPersonName'),
          JSON_VALUE(CASE WHEN ISJSON(l.RAW_JSON) = 1 THEN l.RAW_JSON ELSE N'{}' END, '$.assignedpersonname')) AS ASSIGNED_PERSON_NAME,
        COALESCE(u.USERNAME, l.ASSIGNED_TO_USER_CODE) AS ASSIGNED_TO_NAME
      FROM dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}] l
      LEFT JOIN dbo.[${TABLES.USER}] u ON u.USER_CODE = l.ASSIGNED_TO_USER_CODE
      ${whereSQL}
      ORDER BY l.REGISTERED_DATE DESC, l.LEAD_ID DESC
      ${download ? '' : 'OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY'};
      ${download ? '' : 'SELECT COUNT(*) AS total FROM dbo.[' + TABLES.VISITOR_EXTERNAL_LEAD + '] l ' + whereSQL + ';'}
    `);
    const rows = result.recordsets[0] || [];
    if (!download) return res.json({ data: rows, total: result.recordsets[1]?.[0]?.total || 0, page, limit });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Exhibitor Turned');
    sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'M1' };
    sheet.getColumn('REGISTERED_DATE').numFmt = 'dd mmm yyyy hh:mm';
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="exhibitor-turned-list.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('Exhibitor turned list error:', err);
    return res.status(500).json({ error: 'Unable to load exhibitor turned list.' });
  }
};
