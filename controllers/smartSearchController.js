const { poolPromise } = require("../db");
const sql = require("mssql");

const STOPWORDS = new Set([
  "find", "from", "at", "in", "near", "level", "person", "people", "show",
  "me", "the", "who", "is", "are", "a", "an", "of", "and", "for", "with",
  "contact", "get", "search", "any", "some", "please", "give",
]);

function buildFtQuery(raw) {
  if (!raw) return null;
  const tokens = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens.length) return null;
  const uniq = [...new Set(tokens)];
  return uniq.map((t) => `"${t}*"`).join(" AND ");
}

exports.smartSearch = async (req, res) => {
  try {
    const { q = "", page = 1, limit = 15 } = req.body || {};

    const ftQuery = buildFtQuery(q);
    if (!ftQuery) {
      return res.json({ data: [], total: 0, page: 1, limit: 15 });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("ft", sql.NVarChar(4000), ftQuery)
      .input("offset", sql.Int, offset)
      .input("limit", sql.Int, limitNum)
      .query(`
        WITH Hits AS (
          SELECT kt.[KEY] AS PERSON_CODE, kt.[RANK] AS FT_RANK
          FROM CONTAINSTABLE(dbo.PERSON_SEARCH_INDEX, SEARCH_TEXT, @ft) kt
        )
        SELECT
          p.PERSON_CODE,
          p.COMPANY_CODE,
          si.COMPANY_NAME,
          p.FNAME,
          p.LNAME,
          p.DESIG,
          p.DEPT,
          p.PERSON_EMAIL,
          p.MOBILE,
          si.CITY,
          si.STATE,
          si.INDUSTRY,
          si.DESIGNATION,
          p.UPDATED_DATE,
          p.USER_CODE,
          p.USERNAME,
          COUNT(*) OVER () AS TotalCount
        FROM Hits h
        JOIN dbo.PERSON_SEARCH_INDEX si ON si.PERSON_CODE = h.PERSON_CODE
        JOIN dbo.[COMP_PERSON] p ON p.PERSON_CODE = si.PERSON_CODE
        ORDER BY h.FT_RANK DESC, p.UPDATED_DATE DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      `);

    const rows = result.recordset;
    res.json({
      data: rows.map(({ TotalCount, ...r }) => r),
      total: rows.length ? rows[0].TotalCount : 0,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("Smart search error:", err?.originalError || err);
    res.status(500).json({ error: "Smart search failed" });
  }
};
