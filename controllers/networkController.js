const { poolPromise, sql } = require("../db");
const { TABLES } = require("../helper");

// Generate a unique LIST_CODE ("NL" + 8 hex), same pattern as addTags TAG_CODE.
const generateListCode = async (pool) => {
  let code;
  let exists = true;
  while (exists) {
    code = "NL" + Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, "0");
    const chk = await pool.request()
      .input("LIST_CODE", sql.VarChar(50), code)
      .query(`SELECT 1 FROM dbo.${TABLES.NETWORK_LIST} WHERE LIST_CODE = @LIST_CODE`);
    exists = chk.recordset.length > 0;
  }
  return code;
};

const asArray = (v) => {
  const clean = (arr) => arr.filter(x => x != null && String(x).trim() !== "").map(x => String(x).trim());
  if (Array.isArray(v)) return clean(v);
  if (v == null) return [];
  const s = String(v).trim();
  if (s === "") return [];
  if (s.startsWith("[")) {
    try { const p = JSON.parse(s); return Array.isArray(p) ? clean(p) : []; } catch { /* fall through */ }
  }
  return [s];
};

/**
 * GET /network/candidates
 * Find persons at OTHER companies in the same industry/segment, filtered by designation (+ optional rank cap).
 * Params: industries[], segments[], designations[], rankMax?, excludeCompany, search?, page, limit
 */
exports.getCandidates = async (req, res) => {
  try {
    const {
      excludeCompany = "",
      search = "",
      page = 1,
      limit = 15,
    } = req.query;

    const industries = asArray(req.query.industries);
    const segments = asArray(req.query.segments);
    const designations = asArray(req.query.designations);

    if (industries.length === 0 && segments.length === 0) {
      return res.status(400).json({ error: "Select at least one industry or segment" });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 15;
    const offset = (pageNum - 1) * limitNum;

    const request = (await poolPromise).request();
    const whereClauses = [];

    // Industry / segment match via the company's segment mapping (same shape as getPersonList).
    const segWhere = [];
    if (industries.length) {
      const names = industries.map((v, i) => { request.input(`nind_${i}`, sql.NVarChar, v); return `@nind_${i}`; });
      segWhere.push(`s.INDUSTRY IN (${names.join(", ")})`);
    }
    if (segments.length) {
      const codes = segments.map((v, i) => { request.input(`nseg_${i}`, sql.NVarChar, v); return `@nseg_${i}`; });
      segWhere.push(`m.SEG_CODE IN (${codes.join(", ")})`);
    }
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
      INNER JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
      WHERE m.COMPANY_CODE = p.COMPANY_CODE AND ${segWhere.join(" AND ")}
    )`);

    // Exclude the anchor company itself.
    if (excludeCompany && excludeCompany.trim()) {
      request.input("excludeCompany", sql.VarChar(50), excludeCompany.trim());
      whereClauses.push(`p.COMPANY_CODE <> @excludeCompany`);
    }

    // Designation match: DESIG is a JSON array of {value, rank}; OR of LIKE per selected designation.
    if (designations.length) {
      const desigOr = designations.map((v, i) => {
        request.input(`ndesig_${i}`, sql.NVarChar, `%${v}%`);
        return `p.DESIG LIKE @ndesig_${i}`;
      });
      whereClauses.push(`(${desigOr.join(" OR ")})`);
    }

    // Optional free-text search on name / company.
    if (search && search.trim()) {
      request.input("nsearch", sql.NVarChar, `%${search.trim()}%`);
      whereClauses.push(`(p.FNAME LIKE @nsearch OR p.LNAME LIKE @nsearch OR (p.FNAME + ' ' + p.LNAME) LIKE @nsearch OR cd.COMPANY_NAME LIKE @nsearch)`);
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const query = `
      WITH CandidateData AS (
        SELECT
          p.PERSON_CODE,
          p.COMPANY_CODE,
          cd.COMPANY_NAME,
          p.PREFIX, p.FNAME, p.LNAME,
          p.DESIG, p.DEPT, p.MOBILE, p.OLD_MOBILE, p.PERSON_EMAIL,
          COUNT(*) OVER () AS TotalCount,
          ROW_NUMBER() OVER (ORDER BY p.FNAME, p.LNAME) AS RowNum
        FROM dbo.[${TABLES.COMP_PERSON}] p
        LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] cd ON cd.COMPANY_CODE = p.COMPANY_CODE
        ${whereSQL}
      )
      SELECT * FROM CandidateData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
    `;

    const result = await request.query(query);
    const rows = result.recordset;

    res.json({
      data: rows.map(({ TotalCount, RowNum, ...rest }) => rest),
      total: rows.length > 0 ? rows[0].TotalCount : 0,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("getCandidates error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * POST /network/matches
 * body: { sourceCompanyCode, listCode?, remarks?, persons: [{personCode, personCompanyCode, designation, rank, industry, segment}] }
 * Bulk insert, skipping rows that violate the unique (SOURCE_COMPANY_CODE, PERSON_CODE) constraint.
 */
exports.saveMatches = async (req, res) => {
  try {
    const { sourceCompanyCode, listCode = null, remarks = null, persons = [], usercode = null } = req.body;

    if (!sourceCompanyCode) return res.status(400).json({ error: "Source company is required" });
    if (!Array.isArray(persons) || persons.length === 0) {
      return res.status(400).json({ error: "No persons selected to map" });
    }

    const pool = await poolPromise;
    let inserted = 0;
    let skipped = 0;

    for (const person of persons) {
      if (!person || !person.personCode) { skipped++; continue; }
      // Skip if this person is already mapped to this source company.
      const dup = await pool.request()
        .input("SOURCE_COMPANY_CODE", sql.VarChar(50), sourceCompanyCode)
        .input("PERSON_CODE", sql.VarChar(50), person.personCode)
        .query(`SELECT 1 FROM dbo.${TABLES.NETWORK_MATCH} WHERE SOURCE_COMPANY_CODE = @SOURCE_COMPANY_CODE AND PERSON_CODE = @PERSON_CODE`);
      if (dup.recordset.length > 0) { skipped++; continue; }

      await pool.request()
        .input("SOURCE_COMPANY_CODE", sql.VarChar(50), sourceCompanyCode)
        .input("PERSON_CODE", sql.VarChar(50), person.personCode)
        .input("PERSON_COMPANY_CODE", sql.VarChar(50), person.personCompanyCode || null)
        .input("DESIGNATION", sql.VarChar(200), person.designation || null)
        .input("DESIG_RANK", sql.Int, Number.isFinite(parseInt(person.rank, 10)) ? parseInt(person.rank, 10) : null)
        .input("INDUSTRY", sql.VarChar(255), person.industry || null)
        .input("SEGMENT", sql.VarChar(255), person.segment || null)
        .input("LIST_CODE", sql.VarChar(50), listCode || null)
        .input("REMARKS", sql.VarChar(255), remarks || null)
        .input("USER_CODE", sql.VarChar(50), usercode || null)
        .query(`
          INSERT INTO dbo.${TABLES.NETWORK_MATCH}
            (SOURCE_COMPANY_CODE, PERSON_CODE, PERSON_COMPANY_CODE, DESIGNATION, DESIG_RANK, INDUSTRY, SEGMENT, LIST_CODE, REMARKS, USER_CODE)
          VALUES
            (@SOURCE_COMPANY_CODE, @PERSON_CODE, @PERSON_COMPANY_CODE, @DESIGNATION, @DESIG_RANK, @INDUSTRY, @SEGMENT, @LIST_CODE, @REMARKS, @USER_CODE)
        `);
      inserted++;
    }

    res.json({ success: true, inserted, skipped, message: `${inserted} mapped, ${skipped} skipped` });
  } catch (err) {
    console.error("saveMatches error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /network/matches
 * filters: sourceCompany?, listCode?, designation?, industry?, search?, page, limit
 */
exports.getMatches = async (req, res) => {
  try {
    const {
      sourceCompany = "",
      listCode = "",
      designation = "",
      industry = "",
      search = "",
      page = 1,
      limit = 15,
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 15;
    const offset = (pageNum - 1) * limitNum;

    const request = (await poolPromise).request();
    const whereClauses = [];

    if (sourceCompany && sourceCompany.trim()) {
      request.input("f_source", sql.VarChar(50), sourceCompany.trim());
      whereClauses.push(`nm.SOURCE_COMPANY_CODE = @f_source`);
    }
    if (listCode && listCode.trim()) {
      request.input("f_list", sql.VarChar(50), listCode.trim());
      whereClauses.push(`nm.LIST_CODE = @f_list`);
    }
    if (designation && designation.trim()) {
      request.input("f_desig", sql.NVarChar, `%${designation.trim()}%`);
      whereClauses.push(`nm.DESIGNATION LIKE @f_desig`);
    }
    if (industry && industry.trim()) {
      request.input("f_ind", sql.NVarChar, `%${industry.trim()}%`);
      whereClauses.push(`nm.INDUSTRY LIKE @f_ind`);
    }
    if (search && search.trim()) {
      request.input("f_search", sql.NVarChar, `%${search.trim()}%`);
      whereClauses.push(`(p.FNAME LIKE @f_search OR p.LNAME LIKE @f_search OR (p.FNAME + ' ' + p.LNAME) LIKE @f_search OR pcd.COMPANY_NAME LIKE @f_search OR scd.COMPANY_NAME LIKE @f_search)`);
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const query = `
      WITH MatchData AS (
        SELECT
          nm.MATCH_ID,
          nm.SOURCE_COMPANY_CODE,
          scd.COMPANY_NAME AS SOURCE_COMPANY_NAME,
          nm.PERSON_CODE,
          p.PREFIX, p.FNAME, p.LNAME, p.MOBILE, p.PERSON_EMAIL,
          nm.PERSON_COMPANY_CODE,
          pcd.COMPANY_NAME AS PERSON_COMPANY_NAME,
          nm.DESIGNATION,
          nm.DESIG_RANK,
          nm.INDUSTRY,
          nm.SEGMENT,
          nm.LIST_CODE,
          nl.LIST_NAME,
          nm.REMARKS,
          nm.CREATED_DATE,
          COUNT(*) OVER () AS TotalCount,
          ROW_NUMBER() OVER (ORDER BY nm.CREATED_DATE DESC) AS RowNum
        FROM dbo.[${TABLES.NETWORK_MATCH}] nm
        LEFT JOIN dbo.[${TABLES.COMP_PERSON}] p ON p.PERSON_CODE = nm.PERSON_CODE
        LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] pcd ON pcd.COMPANY_CODE = nm.PERSON_COMPANY_CODE
        LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] scd ON scd.COMPANY_CODE = nm.SOURCE_COMPANY_CODE
        LEFT JOIN dbo.[${TABLES.NETWORK_LIST}] nl ON nl.LIST_CODE = nm.LIST_CODE
        ${whereSQL}
      )
      SELECT * FROM MatchData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
    `;

    const result = await request.query(query);
    const rows = result.recordset;

    res.json({
      data: rows.map(({ TotalCount, RowNum, ...rest }) => rest),
      total: rows.length > 0 ? rows[0].TotalCount : 0,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("getMatches error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

/** DELETE /network/matches/:id */
exports.deleteMatch = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;
    await pool.request()
      .input("MATCH_ID", sql.Int, parseInt(id, 10))
      .query(`DELETE FROM dbo.${TABLES.NETWORK_MATCH} WHERE MATCH_ID = @MATCH_ID`);
    res.json({ success: true, message: "Match removed" });
  } catch (err) {
    console.error("deleteMatch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

/** GET /network/lists */
exports.getLists = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT LIST_CODE, LIST_NAME, REMARKS, USER_CODE, CREATED_DATE
      FROM dbo.${TABLES.NETWORK_LIST}
      WHERE ACTIVE = 1
      ORDER BY CREATED_DATE DESC
    `);
    res.json({ data: result.recordset });
  } catch (err) {
    console.error("getLists error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

/** POST /network/lists  body: { LIST_NAME, REMARKS?, usercode? } */
exports.addList = async (req, res) => {
  try {
    const { LIST_NAME, REMARKS = null, usercode = null } = req.body;
    if (!LIST_NAME || !LIST_NAME.trim()) {
      return res.status(400).json({ error: "List name is required" });
    }
    const pool = await poolPromise;

    const existing = await pool.request()
      .input("LIST_NAME", sql.VarChar(150), LIST_NAME.trim())
      .query(`SELECT LIST_CODE FROM dbo.${TABLES.NETWORK_LIST} WHERE LIST_NAME = @LIST_NAME AND ACTIVE = 1`);
    if (existing.recordset.length > 0) {
      return res.status(200).json({ success: true, LIST_CODE: existing.recordset[0].LIST_CODE, message: "List already exists" });
    }

    const LIST_CODE = await generateListCode(pool);
    await pool.request()
      .input("LIST_CODE", sql.VarChar(50), LIST_CODE)
      .input("LIST_NAME", sql.VarChar(150), LIST_NAME.trim())
      .input("REMARKS", sql.VarChar(255), REMARKS || null)
      .input("USER_CODE", sql.VarChar(50), usercode || null)
      .query(`
        INSERT INTO dbo.${TABLES.NETWORK_LIST} (LIST_CODE, LIST_NAME, REMARKS, USER_CODE)
        VALUES (@LIST_CODE, @LIST_NAME, @REMARKS, @USER_CODE)
      `);

    res.json({ success: true, LIST_CODE, message: "List created" });
  } catch (err) {
    console.error("addList error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};
