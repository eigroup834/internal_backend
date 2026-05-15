const { poolPromise } = require("../db");
const sql = require("mssql");
const ExcelJS = require('exceljs');
const { TABLES } = require('../helper');

const generatePersonCode = () => {
  const rawNumber = Date.now() + Math.floor(Math.random() * 1000);
  const hexPart = rawNumber.toString(16).toUpperCase();
  const personCode = `CP${hexPart}`;
  return personCode;
}

exports.getCompanies = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      searchBy = "",
      sortBy = "COMPANY_CODE",
      sortOrder = "ASC",
      filters = "{}",
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    let filterObj = {};
    try {
      filterObj = JSON.parse(filters);
    } catch {
      return res.status(400).json({ error: "Invalid filters JSON" });
    }

    const searchableColumns = {
      COMPANY_CODE: "c.[COMPANY_CODE]",
      COMPANY_NAME: "c.[COMPANY_NAME]",
      EMAIL:        "c.[EMAIL]",
      WEBSITE:      "c.[WEBSITE]",
      PHONES:       "c.[PHONES]",
    };

    const sortableColumns = new Set([
      "COMPANY_CODE", "COMPANY_NAME", "CITY", "STATE", "COUNTRY",
      "PERSON_COUNT", "HISTORY_COUNT",
    ]);
    const safeSortBy = sortableColumns.has(sortBy) ? sortBy : "COMPANY_CODE";
    const safeSortOrder = String(sortOrder).toUpperCase() === "DESC" ? "DESC" : "ASC";
    const aggregateSortColumns = new Set(["PERSON_COUNT", "HISTORY_COUNT"]);
    const orderByExpr = aggregateSortColumns.has(safeSortBy)
      ? `[${safeSortBy}] ${safeSortOrder}`
      : `c.[${safeSortBy}] ${safeSortOrder}`;

    let whereClauses = [];
    const request = (await poolPromise).request();

    const filterColumns = {
      COUNTRY:  "c.COUNTRY",
      STATE:    "c.STATE",
      CITY:     "c.CITY",
      INDUSTRY: "s.INDUSTRY",
      SEGMENT:  "m.SEG_CODE",
    };

    for (const [key, val] of Object.entries(filterObj)) {
      const col = filterColumns[key];
      if (!col) continue;

      if (Array.isArray(val) && val.length > 0) {
        const paramNames = val.map((_, idx) => `@${key}_${idx}`);
        whereClauses.push(`${col} IN (${paramNames.join(", ")})`);
        val.forEach((v, idx) => request.input(`${key}_${idx}`, v));
      } else if (typeof val === "string" && val.trim() !== "") {
        whereClauses.push(`UPPER(${col}) LIKE UPPER(@${key})`);
        request.input(key, `%${val.trim()}%`);
      }
    }

    if (search && search.trim() !== "") {
      const term = search.trim();

      if (searchBy && searchableColumns[searchBy]) {
        const col = searchableColumns[searchBy];
        whereClauses.push(`UPPER(${col}) LIKE UPPER(@search)`);
          if (searchBy === "COMPANY_NAME") {
            request.input("search", `${term}%`);
          } else {
            request.input("search", `%${term}%`);
          }
      } else {
        const orParts = Object.values(searchableColumns)
          .map((col, i) => {
            request.input(`search${i}`, `%${term}%`);
            return `UPPER(${col}) LIKE UPPER(@search${i})`;
          });
        whereClauses.push(`(${orParts.join(" OR ")})`);
      }
    }

    const masterJoin = `
      LEFT JOIN dbo.[${TABLES.COMP_MASTER}] u
        ON c.COMPANY_CODE = u.COMPANY_CODE
    `;

    const whereSQL =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    const query = `
      WITH
      PersonCounts AS (
        SELECT COMPANY_CODE, COUNT(*) AS PERSON_COUNT
        FROM dbo.[${TABLES.COMP_PERSON}]
        GROUP BY COMPANY_CODE
      ),
      HistoryCounts AS (
        SELECT COMPANY_CODE, COUNT(*) AS HISTORY_COUNT
        FROM dbo.[${TABLES.COMP_EXH_HISTORY}]
        GROUP BY COMPANY_CODE
      ),
      CompanyData AS (
        SELECT
          u.REMARKS,
          c.COMPANY_CODE,
          c.COMPANY_NAME,
          c.DIVISION,
          c.ADDRESS,
          c.CITY,
          c.STATE,
          c.COUNTRY,
          c.PINCODE,
          c.PHONES,
          c.EMAIL,
          c.WEBSITE,
          c.OFC_TYPE,
          c.OLDNAME,
          u.UPDATED_DATE,
          u.USER_CODE,
          STRING_AGG(s.INDUSTRY, ', ') AS INDUSTRY,
          STRING_AGG(s.SEGMENT, ', ')  AS SEGMENT,
          ISNULL(pc.PERSON_COUNT, 0)   AS PERSON_COUNT,
          ISNULL(hc.HISTORY_COUNT, 0)  AS HISTORY_COUNT,
          ROW_NUMBER() OVER (ORDER BY ${orderByExpr}) AS RowNum
        FROM dbo.[${TABLES.COMPANY_DETAIL}] c
        INNER JOIN dbo.[${TABLES.COMP_SEGMENT_MAP}] m ON c.COMPANY_CODE = m.COMPANY_CODE
        INNER JOIN dbo.[${TABLES.INDSEGMENT}] s        ON m.SEG_CODE     = s.SEG_CODE
        ${masterJoin}
        LEFT JOIN PersonCounts  pc ON pc.COMPANY_CODE = c.COMPANY_CODE
        LEFT JOIN HistoryCounts hc ON hc.COMPANY_CODE = c.COMPANY_CODE
        ${whereSQL}
        GROUP BY
          c.COMPANY_CODE, c.COMPANY_NAME, c.DIVISION, c.ADDRESS, c.CITY,
          c.STATE, c.COUNTRY, c.PINCODE, c.PHONES, c.EMAIL, c.WEBSITE,
          c.OFC_TYPE, c.OLDNAME, u.UPDATED_DATE, u.USER_CODE, u.REMARKS,
          pc.PERSON_COUNT, hc.HISTORY_COUNT
      )
      SELECT *
      FROM CompanyData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(DISTINCT c.COMPANY_CODE) AS total
      FROM dbo.[${TABLES.COMPANY_DETAIL}] c
      INNER JOIN dbo.[${TABLES.COMP_SEGMENT_MAP}] m ON c.COMPANY_CODE = m.COMPANY_CODE
      INNER JOIN dbo.[${TABLES.INDSEGMENT}] s        ON m.SEG_CODE     = s.SEG_CODE
      ${masterJoin}
      ${whereSQL};
    `;

    const result = await request.query(query);

    res.json({
      data: result.recordsets[0],
      total: result.recordsets[1][0].total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("Company fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getIndustries = async (req, res) => {
  try {
    const request = (await poolPromise).request();
    const query = `
      SELECT DISTINCT INDUSTRY
      FROM dbo.[${TABLES.INDSEGMENT}]
      ORDER BY INDUSTRY;
    `;
    const result = await request.query(query);
    res.json(result.recordset.map(r => r.INDUSTRY));
  } catch (err) {
    console.error("Industry fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getSegmentsByIndustry = async (req, res) => {
  try {
    const { industry } = req.query;
    if (!industry) {
      return res.status(400).json({ error: "Industry is required" });
    }

    const request = (await poolPromise).request();
    request.input("industry", industry);

    const query = `
      SELECT SEGMENT, SEG_CODE
      FROM dbo.[${TABLES.INDSEGMENT}]
      WHERE INDUSTRY = @industry
      ORDER BY SEGMENT;
    `;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error("Segment fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getIndustriesWithSegments = async (req, res) => {
  try {
    const request = (await poolPromise).request();
    const query = `
      SELECT INDUSTRY, SEGMENT, SEG_CODE
      FROM dbo.[${TABLES.INDSEGMENT}]
      ORDER BY INDUSTRY, SEGMENT;
    `;
    const result = await request.query(query);
    const grouped = {};
    result.recordset.forEach(row => {
      if (!grouped[row.INDUSTRY]) {
        grouped[row.INDUSTRY] = [];
      }
      grouped[row.INDUSTRY].push({
        segment: row.SEGMENT,
        code: row.SEG_CODE,
      });
    });
    res.json(grouped);
  } catch (err) {
    console.error("Industry/Segment fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addCompany = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);

  try {
    const {
      name, emails, website, phones, addresses, pincode,
      remarks, division, specialremarks, country, state, city,
      segment = [], usercode, sourcecode, sourceperson, sourcetype, oldname, tags = [],
      nature, orgtype, assocmember, groupCode = null
    } = req.body;

    await transaction.begin();

    const userResult = await new sql.Request(transaction)
      .input("USER_CODE", sql.VarChar, usercode)
      .query(`
        SELECT ISNULL(DATA_COUNT, 0) AS DATA_COUNT 
        FROM dbo.[${TABLES.USER}] 
        WHERE USER_CODE = @USER_CODE
      `);

    if (userResult.recordset.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: "Invalid user code. User not found.",
      });
    }

    const currentCount = userResult.recordset[0].DATA_COUNT || 0;
    const nextCount = currentCount + 1;
    const COMPANY_CODE = `${usercode}${nextCount}`;
    const CREATED_DATE = new Date();
    const Status = 'A';

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar, COMPANY_CODE)
      .input("USER_CODE", sql.VarChar, usercode)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("SOURCE_CODE", sql.VarChar, sourcecode)
      .input("ACTIVE", sql.Bit, 1)
      .input("REMARKS", sql.NVarChar(sql.MAX), remarks || "")
      .input("MANAGEMENT_REMARKS", sql.NVarChar(sql.MAX), specialremarks || "")
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_MASTER}] 
        (COMPANY_CODE, USER_CODE, CREATED_DATE, SOURCE_CODE, ACTIVE, REMARKS, MANAGEMENT_REMARKS)
        VALUES (@COMPANY_CODE, @USER_CODE, @CREATED_DATE, @SOURCE_CODE, @ACTIVE, @REMARKS, @MANAGEMENT_REMARKS)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar, COMPANY_CODE)
      .input("COMPANY_NAME", sql.NVarChar, name)
      .input("DIVISION", sql.NVarChar, division)
      .input("OLDNAME", sql.NVarChar, oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar, city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar, state)
      .input("COUNTRY", sql.NVarChar, country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.VarChar(sql.MAX), JSON.stringify(emails))
      .input("WEBSITE", sql.NVarChar, website)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("NATURE", sql.NVarChar(255), nature || "")
      .input("ORG_TYPE", sql.NVarChar(255), orgtype || "")
      .input("ASSOC_MEMBER", sql.NVarChar(255), assocmember || "")
      .query(`
        INSERT INTO dbo.[${TABLES.COMPANY_DETAIL}]
        (COMPANY_CODE, COMPANY_NAME, DIVISION, OLDNAME, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, CREATED_DATE, NATURE, ORG_TYPE, ASSOC_MEMBER)
        VALUES (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @OLDNAME, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @CREATED_DATE, @NATURE, @ORG_TYPE, @ASSOC_MEMBER)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar, COMPANY_CODE)
      .input("COMPANY_NAME", sql.NVarChar, name)
      .input("DIVISION", sql.NVarChar, division)
      .input("OLDNAME", sql.NVarChar, oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar, city)
      .input("PINCODE", sql.VarChar, pincode)
      .input("STATE", sql.NVarChar, state)
      .input("COUNTRY", sql.NVarChar, country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.VarChar(sql.MAX), JSON.stringify(emails))
      .input("WEBSITE", sql.NVarChar, website)
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .input("USER_CODE", sql.VarChar, usercode)
      .input("STATUS", sql.VarChar(50), Status)
      .input("NATURE", sql.NVarChar(255), nature || "")
      .input("ORG_TYPE", sql.NVarChar(255), orgtype || "")
      .input("ASSOC_MEMBER", sql.NVarChar(255), assocmember || "")
      .query(`
        INSERT INTO dbo.[${TABLES.COMPANY_UPDATE_HISTORY}]
        (COMPANY_CODE, COMPANY_NAME, DIVISION, OLDNAME, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, UPDATED_DATE, USER_CODE, STATUS, NATURE, ORG_TYPE, ASSOC_MEMBER)
        VALUES (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @OLDNAME, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @UPDATED_DATE, @USER_CODE, @STATUS, @NATURE, @ORG_TYPE, @ASSOC_MEMBER)
      `);

    if (Array.isArray(segment) && segment.length > 0) {
      const segLookupReq = new sql.Request(transaction);
      segment.forEach((code, i) => segLookupReq.input(`seg${i}`, sql.VarChar, code));
      const segNamesResult = await segLookupReq.query(`
        SELECT SEG_CODE, SEGMENT FROM dbo.[INDSEGMENT]
        WHERE SEG_CODE IN (${segment.map((_, i) => `@seg${i}`).join(', ')})
      `);
      const segNameMap = Object.fromEntries(
        segNamesResult.recordset.map(r => [r.SEG_CODE, r.SEGMENT])
      );

      const segInsertReq = new sql.Request(transaction);
      segInsertReq.input('CC', sql.VarChar, COMPANY_CODE);
      const segValueClauses = segment.map((segCode, i) => {
        segInsertReq.input(`sn${i}`, sql.NVarChar, segNameMap[segCode] || segCode);
        segInsertReq.input(`sc${i}`, sql.VarChar, segCode);
        return `(@CC, @sn${i}, @sc${i})`;
      });
      await segInsertReq.query(`
        INSERT INTO dbo.[${TABLES.COMP_SEGMENT_MAP}] (COMPANY_CODE, SEGMENT, SEG_CODE)
        VALUES ${segValueClauses.join(', ')}
      `);
    }

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar, COMPANY_CODE)
      .input("SOURCE_CODE", sql.VarChar, sourcecode)
      .input("SOURCE_PERSON", sql.NVarChar, sourceperson)
      .input("SOURCE_TYPE", sql.NVarChar, sourcetype)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO dbo.[${TABLES.DATA_SOURCE}]  
        (SOURCE_CODE, SOURCE_PERSON, SOURCE_TYPE, CREATED_DATE, COMPANY_CODE)
        VALUES (@SOURCE_CODE, @SOURCE_PERSON, @SOURCE_TYPE, @CREATED_DATE, @COMPANY_CODE)
      `);

    await new sql.Request(transaction)
      .input("USER_CODE", sql.VarChar, usercode)
      .query(`
        UPDATE dbo.[${TABLES.USER}] 
        SET DATA_COUNT = ISNULL(DATA_COUNT, 0) + 1
        WHERE USER_CODE = @USER_CODE
      `);

    if (Array.isArray(tags) && tags.length > 0) {
      const validTags = tags.filter(Boolean);
      if (validTags.length > 0) {
        const tagLookupReq = new sql.Request(transaction);
        validTags.forEach((code, i) => tagLookupReq.input(`tag${i}`, sql.VarChar, code));
        const tagNamesResult = await tagLookupReq.query(`
          SELECT TAG_CODE, TAG_NAME FROM dbo.[${TABLES.TAGS}]
          WHERE TAG_CODE IN (${validTags.map((_, i) => `@tag${i}`).join(', ')})
        `);
        const tagNameMap = Object.fromEntries(
          tagNamesResult.recordset.map(r => [r.TAG_CODE, r.TAG_NAME])
        );

        const tagInsertReq = new sql.Request(transaction);
        tagInsertReq.input('TCC', sql.VarChar, COMPANY_CODE);
        tagInsertReq.input('TCD', sql.DateTime, CREATED_DATE);
        const tagValueClauses = validTags.map((tagCode, i) => {
          tagInsertReq.input(`tn${i}`, sql.NVarChar, tagNameMap[tagCode] || tagCode);
          tagInsertReq.input(`tc${i}`, sql.VarChar, tagCode);
          return `(@tn${i}, @tc${i}, @TCC, NULL, @TCD, @TCD)`;
        });
        await tagInsertReq.query(`
          INSERT INTO dbo.[${TABLES.TAGS_MAPPING}] (TAG_NAME, TAG_CODE, COMPANY_CODE, PERSON_CODE, CREATED_DATE, UPDATED_DATE)
          VALUES ${tagValueClauses.join(', ')}
        `);
      }
    }

    if (groupCode) {
      await new sql.Request(transaction)
        .input("COMPANY_CODE", sql.VarChar, COMPANY_CODE)
        .input("GROUP_CODE", sql.VarChar(20), groupCode)
        .input("USER_CODE", sql.VarChar, usercode)
        .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
        .query(`INSERT INTO dbo.[${TABLES.COMPANY_GROUP_MEMBER}] (COMPANY_CODE, GROUP_CODE, USER_CODE, CREATED_DATE) VALUES (@COMPANY_CODE, @GROUP_CODE, @USER_CODE, @CREATED_DATE)`);
    }

    await transaction.commit();

    res.status(201).json({
      success: true,
      message: "Company saved successfully",
      companyCode: COMPANY_CODE,
    });

  } catch (err) {
    console.error("Error saving company:", err);
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }

    res.status(500).json({
      success: false,
      error: err.message || "Server error",
    });
  }
};

exports.EditCompany = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);

  try {
    const {
      companyCode,
      name, emails, website, phones, addresses, pincode,
      remarks, division, specialremarks, country, state, city,
      segment, oldname, usercode,
      nature, orgtype, assocmember, groupCode = null
    } = req.body;

    if (!companyCode) {
      return res.status(400).json({
        success: false,
        message: "Company code is required for update"
      });
    }

    const UPDATED_DATE = new Date();
    const Status = 'U';
    await transaction.begin();

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("REMARKS", sql.NVarChar(sql.MAX), remarks || "")
      .input("MANAGEMENT_REMARKS", sql.NVarChar(sql.MAX), specialremarks || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        UPDATE dbo.[${TABLES.COMP_MASTER}] 
        SET REMARKS = @REMARKS,
            MANAGEMENT_REMARKS = @MANAGEMENT_REMARKS,
            UPDATED_DATE = @UPDATED_DATE
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), division)
      .input("OLDNAME", sql.NVarChar(255), oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(sql.MAX), JSON.stringify(emails))
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .input("NATURE", sql.NVarChar(255), nature || "")
      .input("ORG_TYPE", sql.NVarChar(255), orgtype || "")
      .input("ASSOC_MEMBER", sql.NVarChar(255), assocmember || "")
      .query(`
        UPDATE dbo.[${TABLES.COMPANY_DETAIL}]
        SET COMPANY_NAME = @COMPANY_NAME,
            DIVISION = @DIVISION,
            OLDNAME = @OLDNAME,
            ADDRESS = @ADDRESS,
            CITY = @CITY,
            PINCODE = @PINCODE,
            STATE = @STATE,
            COUNTRY = @COUNTRY,
            PHONES = @PHONES,
            EMAIL = @EMAIL,
            WEBSITE = @WEBSITE,
            UPDATED_DATE = @UPDATED_DATE,
            NATURE = @NATURE,
            ORG_TYPE = @ORG_TYPE,
            ASSOC_MEMBER = @ASSOC_MEMBER
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), division)
      .input("OLDNAME", sql.NVarChar(255), oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(sql.MAX), JSON.stringify(emails))
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("STATUS", sql.VarChar(50), Status)
      .input("NATURE", sql.NVarChar(255), nature || "")
      .input("ORG_TYPE", sql.NVarChar(255), orgtype || "")
      .input("ASSOC_MEMBER", sql.NVarChar(255), assocmember || "")
      .query(`
        INSERT INTO dbo.[${TABLES.COMPANY_UPDATE_HISTORY}]
          (COMPANY_CODE, COMPANY_NAME, DIVISION, OLDNAME, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, UPDATED_DATE, USER_CODE, STATUS, NATURE, ORG_TYPE, ASSOC_MEMBER)
        VALUES
          (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @OLDNAME, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @UPDATED_DATE, @USER_CODE, @STATUS, @NATURE, @ORG_TYPE, @ASSOC_MEMBER)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .query(`DELETE FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] WHERE COMPANY_CODE = @COMPANY_CODE`);

    if (Array.isArray(segment)) {
      for (let seg of segment) {
        await new sql.Request(transaction)
          .input("COMPANY_CODE", sql.VarChar(50), companyCode)
          .input("SEGMENT", sql.NVarChar(255), seg)
          .input("SEG_CODE", sql.VarChar(50), seg)
          .query(`
        INSERT INTO dbo.[${TABLES.COMP_SEGMENT_MAP}] (COMPANY_CODE, SEGMENT, SEG_CODE)
        VALUES (@COMPANY_CODE, @SEGMENT, @SEG_CODE)
      `);
      }
    }

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .query(`DELETE FROM dbo.[${TABLES.COMPANY_GROUP_MEMBER}] WHERE COMPANY_CODE = @COMPANY_CODE`);

    if (groupCode) {
      await new sql.Request(transaction)
        .input("COMPANY_CODE", sql.VarChar(50), companyCode)
        .input("GROUP_CODE", sql.VarChar(20), groupCode)
        .input("USER_CODE", sql.VarChar(50), usercode)
        .query(`INSERT INTO dbo.[${TABLES.COMPANY_GROUP_MEMBER}] (COMPANY_CODE, GROUP_CODE, USER_CODE, CREATED_DATE) VALUES (@COMPANY_CODE, @GROUP_CODE, @USER_CODE, GETDATE())`);
    }

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Company updated successfully",
      companyCode
    });

  } catch (err) {
    console.error("Error updating company:", err);
    if (!transaction._aborted) {
      await transaction.rollback();
    }
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.GetCompanyDetail = async (req, res) => {
  try {
    const { companyCode } = req.params;

    if (!companyCode) {
      return res.status(400).json({ success: false, message: "Company code is required" });
    }

    const pool = await poolPromise;

    const result = await pool.request()
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .query(`
        SELECT 
          d.COMPANY_CODE,
          d.COMPANY_NAME,
          d.DIVISION,
          d.OLDNAME,
          d.ADDRESS,
          d.CITY,
          d.STATE,
          d.COUNTRY,
          d.PINCODE,
          d.PHONES,
          d.EMAIL,
          d.WEBSITE,
          d.NATURE,
          d.ORG_TYPE,
          d.ASSOC_MEMBER,
          ds.SOURCE_CODE,
          ds.SOURCE_PERSON,
          ds.SOURCE_TYPE,
          m.REMARKS,
          m.MANAGEMENT_REMARKS,

          -- LAST UPDATED DETAILS
          h.UPDATED_DATE AS LAST_UPDATED_DATE,
          h.USER_CODE AS LAST_UPDATED_BY_CODE,
          u.USERNAME AS LAST_UPDATED_BY_USERNAME,

          -- INDUSTRIES
          (
            SELECT STRING_AGG(INDUSTRY, ',')
            FROM (
              SELECT DISTINCT i.INDUSTRY
              FROM dbo.${TABLES.COMP_SEGMENT_MAP} s
              JOIN dbo.${TABLES.INDSEGMENT} i 
                ON s.SEG_CODE = i.SEG_CODE
              WHERE s.COMPANY_CODE = m.COMPANY_CODE
            ) x
          ) AS INDUSTRY,

          -- SEGMENT CODES
          (
            SELECT STRING_AGG(SEG_CODE, ',')
            FROM (
              SELECT DISTINCT s.SEG_CODE
              FROM dbo.${TABLES.COMP_SEGMENT_MAP} s
              WHERE s.COMPANY_CODE = m.COMPANY_CODE
            ) x
          ) AS SEG_CODES,

          -- SEGMENT NAMES
          (
            SELECT STRING_AGG(SEGMENT, ',')
            FROM (
              SELECT DISTINCT i.SEGMENT
              FROM dbo.${TABLES.COMP_SEGMENT_MAP} s
              JOIN dbo.${TABLES.INDSEGMENT} i
                ON s.SEG_CODE = i.SEG_CODE
              WHERE s.COMPANY_CODE = m.COMPANY_CODE
            ) x
          ) AS SEGMENTS,

          -- COMPANY GROUP
          (SELECT TOP 1 gm.GROUP_CODE FROM dbo.[${TABLES.COMPANY_GROUP_MEMBER}] gm WHERE gm.COMPANY_CODE = m.COMPANY_CODE) AS GROUP_CODE,
          (SELECT TOP 1 g.GROUP_NAME FROM dbo.[${TABLES.COMPANY_GROUP_MEMBER}] gm JOIN dbo.[${TABLES.COMPANY_GROUP}] g ON gm.GROUP_CODE = g.GROUP_CODE WHERE gm.COMPANY_CODE = m.COMPANY_CODE) AS GROUP_NAME

        FROM dbo.${TABLES.COMP_MASTER} m

        LEFT JOIN dbo.${TABLES.COMPANY_DETAIL} d 
          ON m.COMPANY_CODE = d.COMPANY_CODE

        LEFT JOIN dbo.${TABLES.DATA_SOURCE} ds 
          ON m.COMPANY_CODE = ds.COMPANY_CODE

        -- JOIN LATEST UPDATE HISTORY
        LEFT JOIN (
          SELECT TOP 1 *
          FROM dbo.COMPANY_UPDATE_HISTORY
          WHERE COMPANY_CODE = @COMPANY_CODE
          ORDER BY UPDATED_DATE DESC
        ) h ON m.COMPANY_CODE = h.COMPANY_CODE

        -- JOIN USER TABLE FOR USERNAME
        LEFT JOIN dbo.[USER] u 
          ON h.USER_CODE = u.USER_CODE

        WHERE m.COMPANY_CODE = @COMPANY_CODE;
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    const row = result.recordset[0];

    res.status(200).json({
      ...row,
      INDUSTRY: row.INDUSTRY ? row.INDUSTRY.split(",") : [],
      SEG_CODES: row.SEG_CODES ? row.SEG_CODES.split(",") : [],
      SEGMENTS: row.SEGMENTS ? row.SEGMENTS.split(",") : [],
    });

  } catch (err) {
    console.error("Error fetching company details:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.exportCompanies = async (req, res) => {
  try {
    const { filters = {} } = req.body;
    const request = (await poolPromise).request();
    const whereClauses = [];

    const addFilter = (value, column) => {
      if (value !== undefined && value !== null) {
        if (value.trim() === '') {
          if (column === 'SEGMENT') {
            whereClauses.push(`(seg.SEGMENT IS NULL OR seg.SEGMENT = '')`);
          }
        } else {
          whereClauses.push(`${column.includes('.') ? column : 'c.' + column} = @${column}`);
          request.input(column, value.trim());
        }
      }
    };

    addFilter(filters.COUNTRY, 'COUNTRY');
    addFilter(filters.STATE, 'STATE');
    addFilter(filters.CITY, 'CITY');
    addFilter(filters.INDUSTRY, 'INDUSTRY');
    addFilter(filters.SEGMENT, 'SEGMENT');

    const whereSQL = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const query = `
      SELECT 
        c.COMPANY_CODE,
        c.COMPANY_NAME,
        c.ADDRESS,
        c.CITY,
        c.STATE,
        c.COUNTRY,
        c.PINCODE,
        c.PHONES,
        COALESCE(seg.INDUSTRY, 'N/A') AS INDUSTRY,
        COALESCE(seg.SEGMENT, 'N/A') AS SEGMENT,
        c.OLDNAME,
        c.UPDATED_DATE
      FROM dbo.[${TABLES.COMPANY_DETAIL}] c
      LEFT JOIN (
        SELECT 
          m.COMPANY_CODE,
          STRING_AGG(s.INDUSTRY, ', ') AS INDUSTRY,
          STRING_AGG(s.SEGMENT, ', ') AS SEGMENT
        FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
        LEFT JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
        GROUP BY m.COMPANY_CODE
      ) seg ON c.COMPANY_CODE = seg.COMPANY_CODE
      ${whereSQL};
    `;

    const result = await request.query(query);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Companies');

    worksheet.columns = [
      { header: 'Company Code', key: 'COMPANY_CODE', width: 20 },
      { header: 'Company Name', key: 'COMPANY_NAME', width: 30 },
      { header: 'Address', key: 'ADDRESS', width: 40 },
      { header: 'City', key: 'CITY', width: 20 },
      { header: 'State', key: 'STATE', width: 20 },
      { header: 'Country', key: 'COUNTRY', width: 20 },
      { header: 'Pin Code', key: 'PINCODE', width: 15 },
      { header: 'Phones', key: 'PHONES', width: 30 },
      { header: 'Industry', key: 'INDUSTRY', width: 25 },
      { header: 'Segment', key: 'SEGMENT', width: 25 },
      { header: 'Old Name', key: 'OLDNAME', width: 25 },
      { header: 'Last Updated', key: 'UPDATED_DATE', width: 25 },
    ];

    result.recordset.forEach(c => {
      let phones = '';
      if (c.PHONES) {
        if (typeof c.PHONES === 'string') {
          try {
            const arr = JSON.parse(c.PHONES);
            phones = arr.map(p => `${p.type}: ${p.isd || ''}${p.std ? '-' + p.std : ''}-${p.number}`).join(', ');
          } catch {
            phones = c.PHONES;
          }
        } else if (Array.isArray(c.PHONES)) {
          phones = c.PHONES.map(p => `${p.type}: ${p.isd || ''}${p.std ? '-' + p.std : ''}-${p.number}`).join(', ');
        }
      }

      worksheet.addRow({
        COMPANY_CODE: c.COMPANY_CODE,
        COMPANY_NAME: c.COMPANY_NAME,
        ADDRESS: c.ADDRESS,
        CITY: c.CITY,
        STATE: c.STATE,
        COUNTRY: c.COUNTRY,
        PINCODE: c.PINCODE || 'N/A',
        PHONES: phones,
        INDUSTRY: c.INDUSTRY,
        SEGMENT: c.SEGMENT,
        OLDNAME: c.OLDNAME || '',
        UPDATED_DATE: c.UPDATED_DATE ? new Date(c.UPDATED_DATE).toLocaleString() : ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Companies_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export Error:', err);
    res.status(500).json({ message: 'Failed to export companies' });
  }
};

exports.addCompanyHistory = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);
  let transactionStarted = false;

  try {
    const {
      COMPANY_CODE,
      USER_CODE,
      EXH_CODE,
      EXH_NAME,
      EXH_YEAR,
      EXH_LOCATION,
      ATTENDEE,
      REVENUE,
      REV_UNIT,
      AREA,
      EXH_INFO,
      SPONSOR,
      EARLYBIRD_DIS,
      FEEDBACK,
      Info_1,
      Info_2,
      Info_3
    } = req.body;

    if (!COMPANY_CODE || !USER_CODE) {
      return res.status(400).json({
        success: false,
        message: "Company code and user code are required"
      });
    }

    if (!EXH_NAME || !EXH_YEAR || !EXH_LOCATION) {
      return res.status(400).json({
        success: false,
        message: "Exhibition Name, Year, and Location are required"
      });
    }

    await transaction.begin();
    transactionStarted = true;

    const companyResult = await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .query(`
        SELECT COMPANY_NAME 
        FROM dbo.[${TABLES.COMPANY_DETAIL}]
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    if (!companyResult.recordset.length) {
      throw new Error("Invalid company code, company not found");
    }

    const existingRecord = await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("EXH_CODE", sql.VarChar(50), EXH_CODE)
      .query(`
      SELECT 1 AS found
      FROM dbo.[${TABLES.COMP_EXH_HISTORY}]
      WHERE COMPANY_CODE = @COMPANY_CODE
        AND EXH_CODE = @EXH_CODE
    `);

    if (existingRecord.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A record already exists for this Company Code and Exhibition Code"
      });
    }

    const COMPANY_NAME = companyResult.recordset[0].COMPANY_NAME;
    const CREATED_DATE = new Date();
    const UPDATED_DATE = new Date();

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("COMPANY_NAME", sql.NVarChar(255), COMPANY_NAME)
      .input("EXH_CODE", sql.VarChar(50), EXH_CODE)
      .input("EXH_NAME", sql.NVarChar(255), EXH_NAME)
      .input("EXH_YEAR", sql.VarChar(50), EXH_YEAR)
      .input("ATTENDEE", sql.NVarChar(255), ATTENDEE || "")
      .input("EXH_LOCATION", sql.NVarChar(255), EXH_LOCATION)
      .input("REVENUE", sql.Decimal(18, 2), REVENUE || 0)
      .input("REV_UNIT", sql.Decimal(18, 2), REV_UNIT || 0)
      .input("AREA", sql.Decimal(18, 2), AREA || 0)
      .input("EXH_INFO", sql.NVarChar(sql.MAX), EXH_INFO || "")
      .input("SPONSOR", sql.NVarChar(50), SPONSOR || "")
      .input("EARLYBIRD_DIS", sql.NVarChar(50), EARLYBIRD_DIS || "No")
      .input("USER_CODE", sql.VarChar(50), USER_CODE)
      .input("FEEDBACK", sql.NVarChar(sql.MAX), FEEDBACK || "")
      .input("Info_1", sql.NVarChar(sql.MAX), Info_1 || "")
      .input("Info_2", sql.NVarChar(sql.MAX), Info_2 || "")
      .input("Info_3", sql.NVarChar(sql.MAX), Info_3 || "")
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_EXH_HISTORY}]
        (COMPANY_CODE, COMPANY_NAME, EXH_CODE, ATTENDEE, EXH_NAME, EXH_YEAR, EXH_LOCATION, REVENUE, REV_UNIT, AREA, EXH_INFO, SPONSOR, EARLYBIRD_DIS, USER_CODE, CREATED_DATE, UPDATED_DATE, FEEDBACK, Info_1, Info_2, Info_3)
        VALUES
        (@COMPANY_CODE, @COMPANY_NAME, @EXH_CODE, @ATTENDEE, @EXH_NAME, @EXH_YEAR, @EXH_LOCATION, @REVENUE, @REV_UNIT, @AREA, @EXH_INFO, @SPONSOR, @EARLYBIRD_DIS, @USER_CODE, @CREATED_DATE, @UPDATED_DATE, @FEEDBACK, @Info_1, @Info_2, @Info_3)
      `);

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Exhibition history added successfully",
      companyCode: COMPANY_CODE,
      exhCode: EXH_CODE
    });

  } catch (err) {
    console.error("Error adding exhibition history:", err);
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }
    }
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.getCompanyExhHistory = async (req, res) => {
  try {
    const { companyCode, page = 1, limit = 10 } = req.query;

    if (!companyCode) {
      return res.status(400).json({
        success: false,
        message: "Company code is required"
      });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const pool = await poolPromise;

    const result = await pool.request()
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("OFFSET", sql.Int, offset)
      .input("LIMIT", sql.Int, parseInt(limit))
      .query(`
        SELECT h.*, u.USERNAME AS ADDED_BY
        FROM dbo.[${TABLES.COMP_EXH_HISTORY}] h
        LEFT JOIN dbo.[USER] u ON h.USER_CODE = u.USER_CODE
        WHERE h.COMPANY_CODE = @COMPANY_CODE
        ORDER BY h.CREATED_DATE DESC
        OFFSET @OFFSET ROWS
        FETCH NEXT @LIMIT ROWS ONLY
      `);

    const countResult = await pool.request()
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.[${TABLES.COMP_EXH_HISTORY}]
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    const total = countResult.recordset[0].total;

    res.status(200).json({
      success: true,
      data: result.recordset,
      page: parseInt(page),
      limit: parseInt(limit),
      total
    });

  } catch (err) {
    console.error("Error fetching exhibition history:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.getExhibitionNames = async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .query(`
        SELECT DISTINCT EXH_NAME
        FROM dbo.[${TABLES.COMP_EXH_HISTORY}]
        ORDER BY EXH_NAME ASC
      `);

    const names = result.recordset.map(row => row.EXH_NAME);

    res.status(200).json({
      success: true,
      data: names
    });

  } catch (err) {
    console.error("Error fetching exhibition names:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.deleteExhibitionHistory = async (req, res) => {
  const { exhCode } = req.params;

  if (!exhCode) {
    return res.status(400).json({ success: false, message: "EXH_CODE is required" });
  }

  try {
    const pool = await poolPromise;
    await pool.request()
      .input("EXH_CODE", sql.VarChar(50), exhCode)
      .query(`DELETE FROM dbo.[${TABLES.COMP_EXH_HISTORY}] WHERE EXH_CODE = @EXH_CODE`);

    res.status(200).json({ success: true, message: "Exhibition history deleted successfully" });
  } catch (err) {
    console.error("Error deleting exhibition history:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.deletePersonExhibitionHistory = async (req, res) => {
  const { exhCode } = req.params;

  if (!exhCode) {
    return res.status(400).json({ success: false, message: "EXH_CODE is required" });
  }

  try {
    const pool = await poolPromise;
    await pool.request()
      .input("EXH_CODE", sql.VarChar(50), exhCode)
      .query(`DELETE FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] WHERE EXH_CODE = @EXH_CODE`);

    res.status(200).json({ success: true, message: "Exhibition history deleted successfully" });
  } catch (err) {
    console.error("Error deleting exhibition history:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.addPerson = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);

  try {
    const {
      salutation,
      firstname,
      lastname,
      companycode,
      phones,
      emails,
      designations,
      departments,
      dob,
      contactdate,
      remarks,
      management_remarks,
      addresses,
      cupd_remark,
      usercode,
      tags = [],
      sourcecode,
      sourceperson,
      sourcetype,
      participantCategory = []
    } = req.body;

    await transaction.begin();

    if (Array.isArray(emails) && emails.length > 0) {
      const emailList = emails
        .map(e => (typeof e === "string" ? e : e?.email || e?.value || ""))
        .map(e => e.trim().toLowerCase())
        .filter(e => e.length > 0);

     if (emailList.length > 0) {
        const existingEmailsResult = await new sql.Request(transaction)
          .query(`
            SELECT PERSON_EMAIL
            FROM dbo.[${TABLES.COMP_PERSON}]
            WHERE PERSON_EMAIL IS NOT NULL AND PERSON_EMAIL <> ''
          `);

        let duplicateEmail = null;

        for (const row of existingEmailsResult.recordset) {
          let storedEmails = [];
          try {
            const parsed = JSON.parse(row.PERSON_EMAIL);
            if (Array.isArray(parsed)) {
              storedEmails = parsed
                .map(e => (typeof e === "string" ? e : e?.email || e?.value || ""))
                .map(e => e.trim().toLowerCase())
                .filter(e => e.length > 0);
            }
          } catch (e) {
            if (typeof row.PERSON_EMAIL === "string") {
              storedEmails = [row.PERSON_EMAIL.trim().toLowerCase()];
            }
          }

          const match = emailList.find(e => storedEmails.includes(e));
          if (match) {
            duplicateEmail = match;
            break;
          }
        }

        if (duplicateEmail) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Duplicate email "${duplicateEmail}" already exists".`,
          });
        }
      }
    }

    const PERSON_CODE = generatePersonCode();
    const CREATED_DATE = new Date();

    const mobileJson = JSON.stringify(phones?.filter(m => m?.number) || []);
    const emailJson = JSON.stringify(emails?.filter(e => e) || []);
    const desigJson = JSON.stringify(designations?.filter(d => d) || []);
    const deptJson = JSON.stringify(departments?.filter(d => d) || []);
    const addrJson = JSON.stringify(addresses?.filter(a => a) || []);
    const catEntriesJson = JSON.stringify(Array.isArray(participantCategory) ? participantCategory.filter(e => e.category || e.year || e.sourcePerson) : []);

    const dobDate = dob ? new Date(dob) : null;
    const contactDate = contactdate ? new Date(contactdate) : null;
    const Status = 'A';

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.NVarChar(50), salutation || "")
      .input("FNAME", sql.NVarChar(255), firstname || "")
      .input("LNAME", sql.NVarChar(255), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), desigJson)
      .input("DEPT", sql.NVarChar(sql.MAX), deptJson)
      .input("MOBILE", sql.NVarChar(sql.MAX), mobileJson)
      .input("PERSON_EMAIL", sql.NVarChar(sql.MAX), emailJson)
      .input("DOB", sql.Date, dobDate)
      .input("REMARKS", sql.NVarChar(sql.MAX), remarks || "")
      .input("CONTACTDATE", sql.Date, contactDate)
      .input("MANAGEMENT_REMARKS", sql.NVarChar(sql.MAX), management_remarks || "")
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("ADDRESS", sql.NVarChar(sql.MAX), addrJson)
      .input("PERSON_CUPD_REMARK", sql.NVarChar(sql.MAX), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("PARTICIPANT_CATEGORY", sql.NVarChar(sql.MAX), catEntriesJson)
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_PERSON}]
        (PERSON_CODE, COMPANY_CODE, PREFIX, FNAME, LNAME, DESIG, DEPT, MOBILE, PERSON_EMAIL, DOB, REMARKS, CONTACTDATE, MANAGEMENT_REMARKS, USER_CODE, ADDRESS, PERSON_CUPD_REMARK, UPDATED_DATE, CREATED_DATE, PARTICIPANT_CATEGORY)
        VALUES (@PERSON_CODE, @COMPANY_CODE, @PREFIX, @FNAME, @LNAME, @DESIG, @DEPT, @MOBILE, @PERSON_EMAIL, @DOB, @REMARKS, @CONTACTDATE, @MANAGEMENT_REMARKS, @USER_CODE, @ADDRESS, @PERSON_CUPD_REMARK, @UPDATED_DATE, @CREATED_DATE, @PARTICIPANT_CATEGORY)
      `);

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.VarChar(20), salutation || "")
      .input("FNAME", sql.VarChar(40), firstname || "")
      .input("LNAME", sql.VarChar(40), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), JSON.stringify(designations || []))
      .input("DEPT", sql.NVarChar(sql.MAX), JSON.stringify(departments || []))
      .input("MOBILE", sql.NVarChar(sql.MAX), JSON.stringify(phones || []))
      .input("PERSON_EMAIL", sql.NVarChar(sql.MAX), JSON.stringify(emails || []))
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("PERSON_CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .input("STATUS", sql.VarChar(50), Status)
      .input("PARTICIPANT_CATEGORY", sql.NVarChar(sql.MAX), catEntriesJson)
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_PERSON_UPDATE_HISTORY}] (
          PERSON_CODE,
          COMPANY_CODE,
          PREFIX,
          FNAME,
          LNAME,
          DESIG,
          DEPT,
          MOBILE,
          PERSON_EMAIL,
          DOB,
          REMARKS,
          CONTACTDATE,
          MANAGEMENT_REMARKS,
          USER_CODE,
          ADDRESS,
          PERSON_CUPD_REMARK,
          UPDATED_DATE,
          STATUS,
          PARTICIPANT_CATEGORY
        )
        VALUES (
          @PERSON_CODE,
          @COMPANY_CODE,
          @PREFIX,
          @FNAME,
          @LNAME,
          @DESIG,
          @DEPT,
          @MOBILE,
          @PERSON_EMAIL,
          @DOB,
          @REMARKS,
          @CONTACTDATE,
          @MANAGEMENT_REMARKS,
          @USER_CODE,
          @ADDRESS,
          @PERSON_CUPD_REMARK,
          @UPDATED_DATE,
          @STATUS,
          @PARTICIPANT_CATEGORY
        )
      `);


    if (Array.isArray(tags) && tags.length > 0) {
      const validTags = tags.filter(Boolean);
      if (validTags.length > 0) {
        const tagLookupReq = new sql.Request(transaction);
        validTags.forEach((code, i) => tagLookupReq.input(`tag${i}`, sql.VarChar, code));
        const tagNamesResult = await tagLookupReq.query(`
          SELECT TAG_CODE, TAG_NAME FROM dbo.[${TABLES.TAGS}]
          WHERE TAG_CODE IN (${validTags.map((_, i) => `@tag${i}`).join(', ')})
        `);
        const tagNameMap = Object.fromEntries(
          tagNamesResult.recordset.map(r => [r.TAG_CODE, r.TAG_NAME])
        );

        const tagInsertReq = new sql.Request(transaction);
        tagInsertReq.input('TPC', sql.VarChar, PERSON_CODE);
        tagInsertReq.input('TCD', sql.DateTime, CREATED_DATE);
        const tagValueClauses = validTags.map((tagCode, i) => {
          tagInsertReq.input(`tn${i}`, sql.NVarChar, tagNameMap[tagCode] || tagCode);
          tagInsertReq.input(`tc${i}`, sql.VarChar, tagCode);
          return `(@tn${i}, @tc${i}, NULL, @TPC, @TCD, @TCD)`;
        });
        await tagInsertReq.query(`
          INSERT INTO dbo.[${TABLES.TAGS_MAPPING}] (TAG_NAME, TAG_CODE, COMPANY_CODE, PERSON_CODE, CREATED_DATE, UPDATED_DATE)
          VALUES ${tagValueClauses.join(', ')}
        `);
      }
    }

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar, PERSON_CODE)
      .input("SOURCE_CODE", sql.VarChar, sourcecode)
      .input("SOURCE_PERSON", sql.NVarChar, sourceperson)
      .input("SOURCE_TYPE", sql.NVarChar, sourcetype)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO dbo.[${TABLES.DATA_SOURCE}]  
        (SOURCE_CODE, SOURCE_PERSON, SOURCE_TYPE, CREATED_DATE, PERSON_CODE)
        VALUES (@SOURCE_CODE, @SOURCE_PERSON, @SOURCE_TYPE, @CREATED_DATE, @PERSON_CODE)
      `);

    await transaction.commit();

    res.status(201).json({
      success: true,
      message: "Person saved successfully",
      personCode: PERSON_CODE,
    });

  } catch (err) {
    console.error("Error saving person:", err);
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCompPersonList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      sortBy = "PERSON_CODE",
      sortOrder = "ASC",
      companyCode,
      filters = "{}",
    } = req.query;

    if (!companyCode) {
      return res.status(400).json({ error: "companyCode is required" });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    let filterObj = {};
    try {
      filterObj = JSON.parse(filters);
    } catch {
      return res.status(400).json({ error: "Invalid filters JSON" });
    }

    const allowedColumns = [
      "PERSON_CODE",
      "FNAME",
      "LNAME",
      "PERSON_EMAIL",
      "MOBILE",
      "DESIG",
      "DEPT",
      "COMPANY_CODE",
    ];

    const sortColumn = allowedColumns.includes(sortBy)
      ? sortBy
      : "PERSON_CODE";

    const sortDir = sortOrder.toUpperCase() === "DESC" ? "DESC" : "ASC";

    const request = (await poolPromise).request();

    const whereClauses = [];

    whereClauses.push("[COMPANY_CODE] = @companyCode");
    request.input("companyCode", companyCode);

    if (search) {
      const likeClauses = [
        "[FNAME] LIKE @search",
        "[LNAME] LIKE @search",
        "(FNAME + ' ' + LNAME) LIKE @search",
        "(LNAME + ' ' + FNAME) LIKE @search",
        "[PERSON_EMAIL] LIKE @search",
        "[USER_CODE] LIKE @search",
        "[MOBILE] LIKE @search",
      ];

      whereClauses.push("(" + likeClauses.join(" OR ") + ")");
      request.input("search", `%${search.trim().replace(/\s+/g, " ")}%`);
    }

    for (const key in filterObj) {
      if (allowedColumns.includes(key) && filterObj[key] !== "") {
        whereClauses.push(`[${key}] = @${key}`);
        request.input(key, filterObj[key]);
      }
    }

    const whereSQL = whereClauses.length
      ? "WHERE " + whereClauses.join(" AND ")
      : "";

    const dataQuery = `
      WITH PersonData AS (
        SELECT
          p.PERSON_CODE,
          p.COMPANY_CODE,
          p.PREFIX,
          p.FNAME,
          p.LNAME,
          p.DESIG,
          p.DEPT,
          p.MOBILE,
          p.PERSON_EMAIL,
          p.DOB,
          p.REMARKS,
          p.MANAGEMENT_REMARKS,
          p.USER_CODE,
          p.ADDRESS,
          p.UPDATED_DATE,
          p.CREATED_DATE,

          (
            SELECT COUNT(*)
            FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] ph
            WHERE ph.PERSON_CODE = p.PERSON_CODE
          ) AS HISTORY_COUNT,

          ROW_NUMBER() OVER (
            ORDER BY p.[${sortColumn}] ${sortDir}
          ) AS RowNum

        FROM dbo.[${TABLES.COMP_PERSON}] p
        ${whereSQL}
      )

      SELECT *
      FROM PersonData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.COMP_PERSON}] p
      ${whereSQL};
    `;

    const dataResult = await request.query(dataQuery);
    const countResult = await request.query(countQuery);

    res.json({
      data: dataResult.recordset,
      total: countResult.recordset[0].total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("Person fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getPersonList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      searchBy = "",
      sortBy = "PERSON_CODE",
      sortOrder = "ASC",
      filters = "{}",
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    let filterObj = {};
    try {
      filterObj = JSON.parse(filters);
    } catch {
      return res.status(400).json({ error: "Invalid filters JSON" });
    }

    const request = (await poolPromise).request();

    const searchableColumns = {
      NAME: "(p.FNAME + ' ' + p.LNAME)",
      EMAIL: "p.PERSON_EMAIL",
      PHONE: "p.MOBILE",
      PERSON_CODE: "p.PERSON_CODE",
      COMPANY_CODE: "p.COMPANY_CODE",
    };

    const sortableColumns = new Set([
      "PERSON_CODE",
      "FNAME",
      "LNAME",
      "PERSON_EMAIL",
      "MOBILE",
      "COMPANY_CODE",
      "DESIG",
      "DEPT",
      "HISTORY_COUNT",
    ]);

    const safeSortBy = sortableColumns.has(sortBy)
      ? sortBy
      : "PERSON_CODE";

    const safeSortOrder =
      String(sortOrder).toUpperCase() === "DESC" ? "DESC" : "ASC";

    const aggregateSortColumns = new Set(["HISTORY_COUNT"]);

    const orderByExpr = aggregateSortColumns.has(safeSortBy)
      ? `[${safeSortBy}] ${safeSortOrder}`
      : `p.[${safeSortBy}] ${safeSortOrder}`;

    const whereClauses = [];

    if (search && search.trim() !== "") {
      const term = search.trim();

      if (searchBy && searchableColumns[searchBy]) {
        const col = searchableColumns[searchBy];
        whereClauses.push(`UPPER(${col}) LIKE UPPER(@search)`);
        if (searchBy === "NAME") {
          request.input("search", `${term}%`);
        } else {
          request.input("search", `%${term}%`);
        }
      } else {
        const orParts = Object.values(searchableColumns)
          .map((col, i) => {
            request.input(`search${i}`, `%${term}%`);
            return `UPPER(${col}) LIKE UPPER(@search${i})`;
          });
        whereClauses.push(`(${orParts.join(" OR ")})`);
      }
    }

    const filterColumns = {
      PERSON_CODE: "p.PERSON_CODE",
      COMPANY_CODE: "p.COMPANY_CODE",
      DESIG: "p.DESIG",
      DEPT: "p.DEPT",
      PERSON_EMAIL: "p.PERSON_EMAIL",
      MOBILE: "p.MOBILE",
    };

    for (const [key, val] of Object.entries(filterObj)) {
      const col = filterColumns[key];
      if (!col) continue;
      if (Array.isArray(val) && val.length > 0) {
        const paramNames = val.map((_, idx) => `@${key}_${idx}`);
        whereClauses.push(`${col} IN (${paramNames.join(", ")})`);
        val.forEach((v, idx) => {
          request.input(`${key}_${idx}`, v);
        });
      } else if (typeof val === "string" && val.trim() !== "") {
        whereClauses.push(`UPPER(${col}) LIKE UPPER(@${key})`);
        request.input(key, `%${val.trim()}%`);
      }
    }

    const whereSQL =
      whereClauses.length > 0
        ? "WHERE " + whereClauses.join(" AND ")
        : "";

    const query = `
      WITH PersonData AS (
        SELECT
          p.PERSON_CODE,
          p.COMPANY_CODE,
          cd.COMPANY_NAME,
          p.PREFIX,
          p.FNAME,
          p.LNAME,
          p.DESIG,
          p.DEPT,
          p.MOBILE,
          p.PERSON_EMAIL,
          p.DOB,
          p.REMARKS,
          p.MANAGEMENT_REMARKS,
          p.USER_CODE,
          p.ADDRESS,
          p.UPDATED_DATE,
          p.CREATED_DATE,

          (
            SELECT COUNT(*)
            FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] h
            WHERE h.PERSON_CODE = p.PERSON_CODE
          ) AS HISTORY_COUNT,

          ROW_NUMBER() OVER (
            ORDER BY ${orderByExpr}
          ) AS RowNum

        FROM dbo.[${TABLES.COMP_PERSON}] p
        LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] cd ON cd.COMPANY_CODE = p.COMPANY_CODE
        ${whereSQL}
      )

      SELECT *
      FROM PersonData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.COMP_PERSON}] p
      ${whereSQL};
    `;

    const result = await request.query(query);

    res.json({
      data: result.recordsets[0],
      total: result.recordsets[1][0].total,
      page: pageNum,
      limit: limitNum,
    });

  } catch (err) {
    console.error("Person fetch error:", err?.originalError || err);

    res.status(500).json({
      error: "Server error",
    });
  }
};

exports.GetPersonDetail = async (req, res) => {
  try {
    const { personCode } = req.params;

    if (!personCode) {
      return res.status(400).json({ success: false, message: "Person code is required" });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .query(`
        SELECT
          m.PERSON_CODE,
          m.COMPANY_CODE,
          m.PREFIX,
          m.FNAME,
          m.LNAME,
          m.DESIG,
          m.DEPT,
          m.MOBILE,
          m.PERSON_EMAIL,
          m.DOB,
          m.REMARKS,
          m.CONTACTDATE,
          m.MANAGEMENT_REMARKS,
          m.USER_CODE,
          m.ADDRESS,
          m.PERSON_CUPD_REMARK,
          m.PARTICIPANT_CATEGORY,

          ds.SOURCE_PERSON,
          ds.SOURCE_TYPE,

          h.UPDATED_DATE AS LAST_UPDATED_DATE,
          h.USER_CODE AS LAST_UPDATED_BY_CODE,
          u.USERNAME AS LAST_UPDATED_BY_USERNAME

        FROM dbo.[${TABLES.COMP_PERSON}] m

        LEFT JOIN dbo.[${TABLES.DATA_SOURCE}] ds
          ON ds.PERSON_CODE = m.PERSON_CODE

        LEFT JOIN (
            SELECT TOP 1 PERSON_CODE, USER_CODE, UPDATED_DATE
            FROM dbo.[${TABLES.COMP_PERSON_UPDATE_HISTORY}]
            WHERE PERSON_CODE = @PERSON_CODE
            ORDER BY UPDATED_DATE DESC
        ) h ON m.PERSON_CODE = h.PERSON_CODE

        LEFT JOIN dbo.[USER] u
          ON h.USER_CODE = u.USER_CODE

        WHERE m.PERSON_CODE = @PERSON_CODE
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Person not found" });
    }

    res.status(200).json(result.recordset[0]);

  } catch (err) {
    console.error("Error fetching person details:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.EditPerson = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);

  try {
    const {
      personCode,
      companycode,
      salutation,
      firstname,
      lastname,
      designations,
      departments,
      phones,
      emails,
      dob,
      remarks,
      management_remarks,
      contactdate,
      addresses,
      cupd_remark,
      usercode,
      participantCategory = []
    } = req.body;

    if (!personCode) {
      return res.status(400).json({
        success: false,
        message: "Person code is required for update",
      });
    }

    const catEntriesJson = JSON.stringify(Array.isArray(participantCategory) ? participantCategory.filter(e => e.category || e.year || e.sourcePerson) : []);
    const UPDATED_DATE = new Date();
    const Status = 'U';
    await transaction.begin();

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.VarChar(20), salutation || "")
      .input("FNAME", sql.VarChar(40), firstname || "")
      .input("LNAME", sql.VarChar(40), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), JSON.stringify(designations || []))
      .input("DEPT", sql.NVarChar(sql.MAX), JSON.stringify(departments || []))
      .input("MOBILE", sql.NVarChar(sql.MAX), JSON.stringify(phones || []))
      .input("PERSON_EMAIL", sql.NVarChar(sql.MAX), JSON.stringify(emails || []))
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("PERSON_CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .input("PARTICIPANT_CATEGORY", sql.NVarChar(sql.MAX), catEntriesJson)
      .query(`
        UPDATE dbo.[${TABLES.COMP_PERSON}]
        SET
          COMPANY_CODE = @COMPANY_CODE,
          PREFIX = @PREFIX,
          FNAME = @FNAME,
          LNAME = @LNAME,
          DESIG = @DESIG,
          DEPT = @DEPT,
          MOBILE = @MOBILE,
          PERSON_EMAIL = @PERSON_EMAIL,
          DOB = @DOB,
          REMARKS = @REMARKS,
          CONTACTDATE = @CONTACTDATE,
          MANAGEMENT_REMARKS = @MANAGEMENT_REMARKS,
          USER_CODE = @USER_CODE,
          ADDRESS = @ADDRESS,
          PERSON_CUPD_REMARK = @PERSON_CUPD_REMARK,
          UPDATED_DATE = @UPDATED_DATE,
          PARTICIPANT_CATEGORY = @PARTICIPANT_CATEGORY
        WHERE PERSON_CODE = @PERSON_CODE
      `);

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.VarChar(20), salutation || "")
      .input("FNAME", sql.VarChar(40), firstname || "")
      .input("LNAME", sql.VarChar(40), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), JSON.stringify(designations || []))
      .input("DEPT", sql.NVarChar(sql.MAX), JSON.stringify(departments || []))
      .input("MOBILE", sql.NVarChar(sql.MAX), JSON.stringify(phones || []))
      .input("PERSON_EMAIL", sql.NVarChar(sql.MAX), JSON.stringify(emails || []))
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("PERSON_CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .input("STATUS", sql.VarChar(50), Status)
      .input("PARTICIPANT_CATEGORY", sql.NVarChar(sql.MAX), catEntriesJson)
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_PERSON_UPDATE_HISTORY}] (
          PERSON_CODE,
          COMPANY_CODE,
          PREFIX,
          FNAME,
          LNAME,
          DESIG,
          DEPT,
          MOBILE,
          PERSON_EMAIL,
          DOB,
          REMARKS,
          CONTACTDATE,
          MANAGEMENT_REMARKS,
          USER_CODE,
          ADDRESS,
          PERSON_CUPD_REMARK,
          UPDATED_DATE,
          STATUS,
          PARTICIPANT_CATEGORY
        )
        VALUES (
          @PERSON_CODE,
          @COMPANY_CODE,
          @PREFIX,
          @FNAME,
          @LNAME,
          @DESIG,
          @DEPT,
          @MOBILE,
          @PERSON_EMAIL,
          @DOB,
          @REMARKS,
          @CONTACTDATE,
          @MANAGEMENT_REMARKS,
          @USER_CODE,
          @ADDRESS,
          @PERSON_CUPD_REMARK,
          @UPDATED_DATE,
          @STATUS,
          @PARTICIPANT_CATEGORY
        )
      `);

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Person updated successfully",
      personCode,
    });
  } catch (err) {
    console.error("Error updating person:", err);
    if (!transaction._aborted) {
      await transaction.rollback();
    }
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

exports.getPersonExhHistory = async (req, res) => {
  try {
    const { personCode, page = 1, limit = 10 } = req.query;

    if (!personCode) {
      return res.status(400).json({
        success: false,
        message: "Person code is required"
      });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const pool = await poolPromise;

    const result = await pool.request()
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .input("OFFSET", sql.Int, offset)
      .input("LIMIT", sql.Int, parseInt(limit))
      .query(`
        SELECT h.*, u.USERNAME AS ADDED_BY,
          p.FNAME, p.LNAME, p.COMPANY_CODE,
          cd.COMPANY_NAME
        FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] h
        LEFT JOIN dbo.[USER] u ON h.USER_CODE = u.USER_CODE
        LEFT JOIN dbo.[${TABLES.COMP_PERSON}] p ON p.PERSON_CODE = h.PERSON_CODE
        LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] cd ON cd.COMPANY_CODE = p.COMPANY_CODE
        WHERE h.PERSON_CODE = @PERSON_CODE
        ORDER BY h.CREATED_DATE DESC
        OFFSET @OFFSET ROWS
        FETCH NEXT @LIMIT ROWS ONLY
      `);

    const countResult = await pool.request()
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}]
        WHERE PERSON_CODE = @PERSON_CODE
      `);

    const total = countResult.recordset[0].total;

    res.status(200).json({
      success: true,
      data: result.recordset,
      page: parseInt(page),
      limit: parseInt(limit),
      total
    });

  } catch (err) {
    console.error("Error fetching exhibition history:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.addPersonHistory = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);
  let transactionStarted = false;

  try {
    const {
      PERSON_CODE,
      USER_CODE,
      EXH_CODE,
      EXH_NAME,
      EXH_YEAR,
      ATTENDEE,
      SPEAKER,
      PROSPECT,
      BUYER,
      DELEGATE_INTERNATIONAL,
      DELEGATE_NATIONAL,
      INVESTOR,
      INVITEE,
      MARKETING,
      MEDIA,
      ORGANISER,
      POTENTIAL_EXHIBITOR,
      VIP,
      VISITOR
    } = req.body;

    if (!PERSON_CODE || !USER_CODE) {
      return res.status(400).json({
        success: false,
        message: "Person code and user code are required"
      });
    }

    if (!EXH_NAME || !EXH_YEAR) {
      return res.status(400).json({
        success: false,
        message: "Exhibition Name, Year, and Location are required"
      });
    }

    await transaction.begin();
    transactionStarted = true;

    const personResult = await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .query(`
        SELECT FNAME
        FROM dbo.[${TABLES.COMP_PERSON}]
        WHERE PERSON_CODE = @PERSON_CODE
      `);

    if (!personResult.recordset.length) {
      throw new Error("Invalid person code, person not found");
    }

    const existingRecord = await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .input("EXH_CODE", sql.VarChar(50), EXH_CODE)
      .query(`
        SELECT 1 AS found
        FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}]
        WHERE PERSON_CODE = @PERSON_CODE
          AND EXH_CODE = @EXH_CODE
      `);

    if (existingRecord.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A record already exists for this Person Code and Exhibition Code"
      });
    }

    const CREATED_DATE = new Date();
    const UPDATED_DATE = new Date();

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .input("EXH_CODE", sql.VarChar(50), EXH_CODE)
      .input("EXH_NAME", sql.NVarChar(255), EXH_NAME)
      .input("EXH_YEAR", sql.VarChar(50), EXH_YEAR)
      .input("ATTENDEE", sql.NVarChar(255), ATTENDEE || "")
      .input("SPEAKER", sql.NVarChar(10), SPEAKER || "No")
      .input("VISITOR", sql.NVarChar(10), VISITOR || "No")
      .input("INVITEE", sql.NVarChar(10), INVITEE || "No")
      .input("MARKETING", sql.NVarChar(10), MARKETING || "No")
      .input("PROSPECT", sql.NVarChar(10), PROSPECT || "No")

      .input("BUYER", sql.NVarChar(10), BUYER || "No")
      .input("DELEGATE_INTERNATIONAL", sql.NVarChar(10), DELEGATE_INTERNATIONAL || "No")
      .input("DELEGATE_NATIONAL", sql.NVarChar(10), DELEGATE_NATIONAL || "No")
      .input("INVESTOR", sql.NVarChar(10), INVESTOR || "No")
      .input("MEDIA", sql.NVarChar(10), MEDIA || "No")
      .input("ORGANISER", sql.NVarChar(10), ORGANISER || "No")
      .input("POTENTIAL_EXHIBITOR", sql.NVarChar(10), POTENTIAL_EXHIBITOR || "No")
      .input("VIP", sql.NVarChar(10), VIP || "No")

      .input("USER_CODE", sql.VarChar(50), USER_CODE)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        INSERT INTO dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}]
        (
          PERSON_CODE, EXH_CODE, EXH_NAME, EXH_YEAR,
          SPEAKER, VISITOR, INVITEE, MARKETING, PROSPECT, ATTENDEE, BUYER,  DELEGATE_INTERNATIONAL, 
          DELEGATE_NATIONAL, INVESTOR, MEDIA, ORGANISER, POTENTIAL_EXHIBITOR, VIP,
          USER_CODE, CREATED_DATE, UPDATED_DATE
        )
        VALUES
        (
          @PERSON_CODE, @EXH_CODE, @EXH_NAME, @EXH_YEAR,
          @SPEAKER, @VISITOR, @INVITEE, @MARKETING, @PROSPECT, @ATTENDEE, @BUYER,  @DELEGATE_INTERNATIONAL, 
          @DELEGATE_NATIONAL, @INVESTOR, @MEDIA, @ORGANISER, @POTENTIAL_EXHIBITOR, @VIP,
          @USER_CODE, @CREATED_DATE, @UPDATED_DATE
        )
      `);

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Person exhibition history added successfully",
      personCode: PERSON_CODE,
      exhCode: EXH_CODE
    });

  } catch (err) {
    console.error("Error adding person exhibition history:", err);
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }
    }
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.getAllCompaniesWithSearch = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "", companyCode = "" } = req.query;

    const request = pool.request();
    let query = "";

    if (companyCode && !search.trim()) {
      query = `
        SELECT COMPANY_CODE, COMPANY_NAME, ADDRESS
        FROM dbo.[${TABLES.COMPANY_DETAIL}]
        WHERE COMPANY_CODE = @companyCode
      `;

      request.input(
        "companyCode",
        sql.VarChar(50),
        companyCode
      );
    }

    // CASE 2: search only
    else if (search.trim()) {

      const trimmedSearch = search.trim();

      query = `
        SELECT TOP 50
          COMPANY_CODE,
          COMPANY_NAME,
          ADDRESS
        FROM dbo.[${TABLES.COMPANY_DETAIL}]
        WHERE
          COMPANY_NAME LIKE @nameSearch
          OR COMPANY_CODE LIKE @codeSearch
        ORDER BY COMPANY_NAME
      `;

      request.input(
        "nameSearch",
        sql.VarChar(200),
        `${trimmedSearch}%`
      );

      request.input(
        "codeSearch",
        sql.VarChar(200),
        `%${trimmedSearch}%`
      );
    }

    else {
      query = `
        SELECT TOP 50
          COMPANY_CODE,
          COMPANY_NAME,
          ADDRESS
        FROM dbo.[${TABLES.COMPANY_DETAIL}]
        ORDER BY COMPANY_NAME
      `;
    }

    const result = await request.query(query);

    return res.json({
      data: result.recordset,
      total: result.recordset.length,
    });

  } catch (err) {
    console.error("getCompany error:", err);
    return res.status(500).json({
      error: "Server error",
    });
  }
};










