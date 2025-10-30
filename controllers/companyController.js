const { poolPromise } = require("../db");
const sql = require("mssql");
const ExcelJS = require('exceljs');

const generateCompanyCode = async (usercode, transaction) => {
  const request = new sql.Request(transaction);
  const result = await request
    .input("USER_CODE", sql.VarChar(50), usercode)
    .query(`
      SELECT DATA_COUNT
      FROM DEVP_USER
      WHERE USER_CODE = @USER_CODE
    `);

  let nextCount = 1;
  if (result.recordset.length > 0 && result.recordset[0].DATA_COUNT !== null) {
    nextCount = result.recordset[0].DATA_COUNT + 1;
  }
  const companyCode = `${usercode}${nextCount}`;
  return { companyCode, nextCount };
};

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

    let whereClauses = [];
    let request = (await poolPromise).request();

    const filterColumns = {
      COUNTRY: "c.COUNTRY",
      STATE: "c.STATE",
      CITY: "c.CITY",
      INDUSTRY: "s.INDUSTRY",
      SEGMENT: "m.SEG_CODE"
    };

    for (const [key, val] of Object.entries(filterObj)) {
      const col = filterColumns[key];
      if (!col) continue;

      if (Array.isArray(val) && val.length > 0) {
        const paramNames = val.map((_, idx) => `@${key}_${idx}`);
        const clause = `${col} IN (${paramNames.join(", ")})`;
        whereClauses.push(clause);

        val.forEach((item, idx) => {
          request.input(`${key}_${idx}`, item);
        });
      } else if (typeof val === "string" && val.trim() !== "") {
        if (key === "SEGMENT") {
          whereClauses.push(`UPPER(${col}) = UPPER(@${key})`);
          request.input(key, val.trim());
        } else {
          whereClauses.push(`UPPER(${col}) LIKE UPPER(@${key})`);
          request.input(key, `%${val.trim()}%`);
        }
      }
    }

    if (search) {
      const likeClauses = [
        "c.[COMPANY_NAME] LIKE @search1",
        "c.[COMPANY_CODE] LIKE @search2",
        "c.[EMAIL] LIKE @search3",
        "c.[PHONES] LIKE @search4",
      ];

      whereClauses.push("(" + likeClauses.join(" OR ") + ")");
      request.input("search1", `%${search}%`);
      request.input("search2", `%${search}%`);
      request.input("search3", `%${search}%`);
      request.input("search4", `%${search}%`);
    }

    const whereSQL =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
    const query = `
      WITH CompanyData AS (
        SELECT DISTINCT c.*, s.INDUSTRY, s.SEGMENT,
               ROW_NUMBER() OVER (ORDER BY c.[${sortBy}] ${sortOrder}) AS RowNum
        FROM dbo.DEVP_COMPANY_DETAIL c
        INNER JOIN dbo.DEVP_COMP_SEGMENT_MAP m ON c.COMPANY_CODE = m.COMPANY_CODE
        INNER JOIN dbo.DEVP_INDSEGMENT s ON m.SEG_CODE = s.SEG_CODE
        ${whereSQL}
      )
      SELECT *
      FROM CompanyData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};

      SELECT COUNT(DISTINCT c.COMPANY_CODE) AS total
      FROM dbo.DEVP_COMPANY_DETAIL c
      INNER JOIN dbo.DEVP_COMP_SEGMENT_MAP m ON c.COMPANY_CODE = m.COMPANY_CODE
      INNER JOIN dbo.DEVP_INDSEGMENT s ON m.SEG_CODE = s.SEG_CODE
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
      FROM dbo.DEVP_INDSEGMENT
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
      FROM dbo.DEVP_INDSEGMENT
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
      FROM dbo.DEVP_INDSEGMENT
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
      name, email, website, phones, addresses, pincode,
      remarks, division, specialremarks, country, state, city,
      segment, usercode, sourcecode, sourceperson, sourcetype, oldname, tags = []
    } = req.body;

    await transaction.begin();

    const duplicateCheck = await new sql.Request(transaction)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("EMAIL", sql.NVarChar(255), email)
      .query(`
        SELECT TOP 1 COMPANY_CODE 
        FROM DEVP_COMPANY_DETAIL 
        WHERE COMPANY_NAME = @COMPANY_NAME AND EMAIL = @EMAIL
      `);

    if (duplicateCheck.recordset.length > 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: "Duplicate company found with same name and email.",
      });
    }

    const { companyCode: COMPANY_CODE, nextCount } = await generateCompanyCode(usercode, transaction);
    const CREATED_DATE = new Date();

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("SOURCE_CODE", sql.VarChar(50), sourcecode)
      .input("SOFT_DELETED", sql.Bit, 0)
      .input("REMARKS", sql.NVarChar(sql.MAX), remarks || "")
      .input("MANAGEMENT_REMARKS", sql.NVarChar(sql.MAX), specialremarks || "")
      .query(`
        INSERT INTO DEVP_MASTER (COMPANY_CODE, USER_CODE, CREATED_DATE, SOURCE_CODE, SOFT_DELETED, REMARKS, MANAGEMENT_REMARKS)
        VALUES (@COMPANY_CODE, @USER_CODE, @CREATED_DATE, @SOURCE_CODE, @SOFT_DELETED, @REMARKS, @MANAGEMENT_REMARKS)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), division)
      .input("OLDNAME", sql.NVarChar(255), oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(255), email)
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO DEVP_COMPANY_DETAIL (COMPANY_CODE, COMPANY_NAME, DIVISION, OLDNAME, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, CREATED_DATE)
        VALUES (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @OLDNAME, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @CREATED_DATE)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), division)
      .input("OLDNAME", sql.NVarChar(255), oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(255), email)
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`
        INSERT INTO DEVP_COMPANY_UPDATE_HISTORY (COMPANY_CODE, COMPANY_NAME, DIVISION, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, UPDATED_DATE, USER_CODE)
        VALUES (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @UPDATED_DATE, @USER_CODE)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("SEGMENT", sql.NVarChar(255), segment)
      .input("SEG_CODE", sql.VarChar(50), segment)
      .query(`
        INSERT INTO DEVP_COMP_SEGMENT_MAP (COMPANY_CODE, SEGMENT, SEG_CODE)
        VALUES (@COMPANY_CODE, @SEGMENT, @SEG_CODE)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
      .input("SOURCE_CODE", sql.VarChar(50), sourcecode)
      .input("SOURCE_PERSON", sql.NVarChar(255), sourceperson)
      .input("SOURCE_TYPE", sql.NVarChar(50), sourcetype)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO DEVP_DATA_SOURCE (SOURCE_CODE, SOURCE_PERSON, SOURCE_TYPE, CREATED_DATE, COMPANY_CODE)
        VALUES (@SOURCE_CODE, @SOURCE_PERSON, @SOURCE_TYPE, @CREATED_DATE, @COMPANY_CODE)
      `);

    await new sql.Request(transaction)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("DATA_COUNT", sql.Int, nextCount)
      .query(`
        UPDATE DEVP_USER
        SET DATA_COUNT = @DATA_COUNT
        WHERE USER_CODE = @USER_CODE
      `);

    if (Array.isArray(tags) && tags.length > 0) {
      for (const tagCode of tags) {
        if (!tagCode) continue;

        const tagResult = await new sql.Request(transaction)
          .input("TAG_CODE", sql.VarChar(50), tagCode)
          .query(`
              SELECT TOP 1 TAG_NAME 
              FROM DEVP_TAGS 
              WHERE TAG_CODE = @TAG_CODE
            `);

        const tagName = tagResult.recordset.length > 0
          ? tagResult.recordset[0].TAG_NAME
          : tagCode;

        await new sql.Request(transaction)
          .input("TAG_NAME", sql.NVarChar(255), tagName)
          .input("TAG_CODE", sql.VarChar(50), tagCode)
          .input("COMPANY_CODE", sql.VarChar(50), COMPANY_CODE)
          .input("PERSON_CODE", sql.VarChar(50), null)
          .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
          .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
          .query(`
              INSERT INTO DEVP_TAGS_MAPPING 
              (TAG_NAME, TAG_CODE, COMPANY_CODE, PERSON_CODE, CREATED_DATE, UPDATED_DATE)
              VALUES (@TAG_NAME, @TAG_CODE, @COMPANY_CODE, @PERSON_CODE, @CREATED_DATE, @UPDATED_DATE)
            `);
      }
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
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.EditCompany = async (req, res) => {
  const transaction = new sql.Transaction(await poolPromise);

  try {
    const {
      companyCode,
      name, email, website, phones, addresses, pincode,
      remarks, division, specialremarks, country, state, city,
      segment, oldname, usercode
    } = req.body;

    if (!companyCode) {
      return res.status(400).json({
        success: false,
        message: "Company code is required for update"
      });
    }

    const UPDATED_DATE = new Date();
    await transaction.begin();

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("REMARKS", sql.NVarChar(sql.MAX), remarks || "")
      .input("MANAGEMENT_REMARKS", sql.NVarChar(sql.MAX), specialremarks || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        UPDATE DEVP_MASTER
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
      .input("EMAIL", sql.NVarChar(255), email)
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        UPDATE DEVP_COMPANY_DETAIL
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
            UPDATED_DATE = @UPDATED_DATE
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), division)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(255), email)
      .input("WEBSITE", sql.NVarChar(255), website)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`
        INSERT INTO DEVP_COMPANY_UPDATE_HISTORY 
          (COMPANY_CODE, COMPANY_NAME, DIVISION, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, UPDATED_DATE, USER_CODE)
        VALUES 
          (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @UPDATED_DATE, @USER_CODE)
      `);

    await new sql.Request(transaction)
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .input("SEGMENT", sql.NVarChar(255), segment)
      .input("SEG_CODE", sql.VarChar(50), segment)
      .query(`
        UPDATE DEVP_COMP_SEGMENT_MAP
        SET SEGMENT = @SEGMENT,
            SEG_CODE = @SEG_CODE
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

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
        SELECT m.COMPANY_CODE, i.INDUSTRY, d.COMPANY_NAME, d.DIVISION, d.OLDNAME, d.ADDRESS, d.CITY, d.STATE, d.COUNTRY, d.PINCODE,
               d.PHONES, d.EMAIL, d.WEBSITE, s.SEGMENT, s.SEG_CODE, ds.SOURCE_CODE, ds.SOURCE_PERSON, ds.SOURCE_TYPE,
               m.REMARKS, m.MANAGEMENT_REMARKS
        FROM DEVP_MASTER m
        LEFT JOIN DEVP_COMPANY_DETAIL d ON m.COMPANY_CODE = d.COMPANY_CODE
        LEFT JOIN DEVP_COMP_SEGMENT_MAP s ON m.COMPANY_CODE = s.COMPANY_CODE
        LEFT JOIN DEVP_DATA_SOURCE ds ON m.COMPANY_CODE = ds.COMPANY_CODE
        LEFT JOIN DEVP_INDSEGMENT i ON s.SEG_CODE = i.SEG_CODE
        WHERE m.COMPANY_CODE = @COMPANY_CODE
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    res.status(200).json(result.recordset[0]);

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
      FROM DEVP_COMPANY_DETAIL c
      LEFT JOIN (
        SELECT 
          m.COMPANY_CODE,
          STRING_AGG(s.INDUSTRY, ', ') AS INDUSTRY,
          STRING_AGG(s.SEGMENT, ', ') AS SEGMENT
        FROM DEVP_COMP_SEGMENT_MAP m
        LEFT JOIN DEVP_INDSEGMENT s ON m.SEG_CODE = s.SEG_CODE
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
      REVENUE,
      AREA,
      EXH_INFO,
      SPONSOR,
      EARLYBIRD_DIS,
      FEEDBACK
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
        FROM DEVP_COMPANY_DETAIL
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
    FROM DEVP_COMP_EXH_HISTORY
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
      .input("EXH_LOCATION", sql.NVarChar(255), EXH_LOCATION)
      .input("REVENUE", sql.Decimal(18, 2), REVENUE || 0)
      .input("AREA", sql.Decimal(18, 2), AREA || 0)
      .input("EXH_INFO", sql.NVarChar(sql.MAX), EXH_INFO || "")
      .input("SPONSOR", sql.NVarChar(50), SPONSOR || "")
      .input("EARLYBIRD_DIS", sql.NVarChar(50), EARLYBIRD_DIS || "No")
      .input("USER_CODE", sql.VarChar(50), USER_CODE)
      .input("FEEDBACK", sql.NVarChar(sql.MAX), FEEDBACK || "")
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        INSERT INTO DEVP_COMP_EXH_HISTORY
        (COMPANY_CODE, COMPANY_NAME, EXH_CODE, EXH_NAME, EXH_YEAR, EXH_LOCATION, REVENUE, AREA, EXH_INFO, SPONSOR, EARLYBIRD_DIS, USER_CODE, CREATED_DATE, UPDATED_DATE, FEEDBACK)
        VALUES
        (@COMPANY_CODE, @COMPANY_NAME, @EXH_CODE, @EXH_NAME, @EXH_YEAR, @EXH_LOCATION, @REVENUE, @AREA, @EXH_INFO, @SPONSOR, @EARLYBIRD_DIS, @USER_CODE, @CREATED_DATE, @UPDATED_DATE, @FEEDBACK)
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
        SELECT * 
        FROM DEVP_COMP_EXH_HISTORY
        WHERE COMPANY_CODE = @COMPANY_CODE
        ORDER BY CREATED_DATE DESC
        OFFSET @OFFSET ROWS
        FETCH NEXT @LIMIT ROWS ONLY
      `);

    const countResult = await pool.request()
      .input("COMPANY_CODE", sql.VarChar(50), companyCode)
      .query(`
        SELECT COUNT(*) AS total
        FROM DEVP_COMP_EXH_HISTORY
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
        FROM DEVP_COMP_EXH_HISTORY
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
      .query("DELETE FROM DEVP_COMP_EXH_HISTORY WHERE EXH_CODE = @EXH_CODE");

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
      mobiles,
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
      tags = []
    } = req.body;

    await transaction.begin();

    const PERSON_CODE = generatePersonCode();
    const CREATED_DATE = new Date();

    const mobileJson = JSON.stringify(mobiles?.filter(m => m?.number) || []);
    const emailJson = JSON.stringify(emails?.filter(e => e) || []);
    const desigJson = JSON.stringify(designations?.filter(d => d) || []);
    const deptJson = JSON.stringify(departments?.filter(d => d) || []);
    const addrJson = JSON.stringify(addresses?.filter(a => a) || []);

    const dobDate = dob ? new Date(dob) : null;
    const contactDate = contactdate ? new Date(contactdate) : null;

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
      .input("CUPD_REMARK", sql.NVarChar(sql.MAX), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO DEVP_COMP_PERSON 
        (PERSON_CODE, COMPANY_CODE, PREFIX, FNAME, LNAME, DESIG, DEPT, MOBILE, PERSON_EMAIL, DOB, REMARKS, CONTACTDATE, MANAGEMENT_REMARKS, USER_CODE, ADDRESS, CUPD_REMARK, UPDATED_DATE, CREATED_DATE)
        VALUES (@PERSON_CODE, @COMPANY_CODE, @PREFIX, @FNAME, @LNAME, @DESIG, @DEPT, @MOBILE, @PERSON_EMAIL, @DOB, @REMARKS, @CONTACTDATE, @MANAGEMENT_REMARKS, @USER_CODE, @ADDRESS, @CUPD_REMARK, @UPDATED_DATE, @CREATED_DATE)
      `);

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.VarChar(20), salutation || "")
      .input("FNAME", sql.VarChar(40), firstname || "")
      .input("LNAME", sql.VarChar(40), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), JSON.stringify(designations || []))
      .input("DEPT", sql.NVarChar(sql.MAX), JSON.stringify(departments || []))
      .input("MOBILE", sql.VarChar(35), JSON.stringify(mobiles || []))
      .input("PERSON_EMAIL", sql.VarChar(60), JSON.stringify(emails || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("ADDRESS", sql.VarChar(75), JSON.stringify(addresses || []))
      .input("CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
      .query(`
        INSERT INTO DEVP_COMP_PERSON_UPDATE_HISTORY (
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
          CUPD_REMARK,
          UPDATED_DATE
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
          @CUPD_REMARK,
          @UPDATED_DATE
        )
      `);


    if (Array.isArray(tags) && tags.length > 0) {
      for (const tagCode of tags) {
        if (!tagCode) continue;

        const tagResult = await new sql.Request(transaction)
          .input("TAG_CODE", sql.VarChar(50), tagCode)
          .query(`
              SELECT TOP 1 TAG_NAME 
              FROM DEVP_TAGS 
              WHERE TAG_CODE = @TAG_CODE
            `);

        const tagName = tagResult.recordset.length > 0
          ? tagResult.recordset[0].TAG_NAME
          : tagCode;

        await new sql.Request(transaction)
          .input("TAG_NAME", sql.NVarChar(255), tagName)
          .input("TAG_CODE", sql.VarChar(50), tagCode)
          .input("COMPANY_CODE", sql.VarChar(50), null)
          .input("PERSON_CODE", sql.VarChar(50), PERSON_CODE)
          .input("CREATED_DATE", sql.DateTime, CREATED_DATE)
          .input("UPDATED_DATE", sql.DateTime, CREATED_DATE)
          .query(`
              INSERT INTO DEVP_TAGS_MAPPING 
              (TAG_NAME, TAG_CODE, COMPANY_CODE, PERSON_CODE, CREATED_DATE, UPDATED_DATE)
              VALUES (@TAG_NAME, @TAG_CODE, @COMPANY_CODE, @PERSON_CODE, @CREATED_DATE, @UPDATED_DATE)
            `);
      }
    }
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

exports.getPersonList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
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

    const allowedColumns = [
      "PERSON_CODE",
      "FNAME",
      "LNAME",
      "PERSON_EMAIL",
      "MOBILE",
      "COMPANY_CODE",
      "DESIG",
      "DEPT",
    ];
    const sortColumn = allowedColumns.includes(sortBy) ? sortBy : "PERSON_CODE";
    const sortDir = sortOrder.toUpperCase() === "DESC" ? "DESC" : "ASC";

    const whereClauses = [];
    const request = (await poolPromise).request();

    // 🔍 Search support (FNAME, LNAME, EMAIL, MOBILE, COMPANY_CODE)
    if (search) {
      const likeClauses = [
        "[FNAME] LIKE @search1",
        "[LNAME] LIKE @search2",
        "[PERSON_EMAIL] LIKE @search3",
        "[MOBILE] LIKE @search4",
        "[COMPANY_CODE] LIKE @search5",
      ];
      whereClauses.push("(" + likeClauses.join(" OR ") + ")");
      request.input("search1", `%${search}%`);
      request.input("search2", `%${search}%`);
      request.input("search3", `%${search}%`);
      request.input("search4", `%${search}%`);
      request.input("search5", `%${search}%`);
    }

    for (const key in filterObj) {
      if (allowedColumns.includes(key) && filterObj[key] !== "") {
        whereClauses.push(`[${key}] = @${key}`);
        request.input(key, filterObj[key]);
      }
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const dataQuery = `
      WITH PersonData AS (
        SELECT *,
               ROW_NUMBER() OVER (ORDER BY [${sortColumn}] ${sortDir}) AS RowNum
        FROM dbo.DEVP_COMP_PERSON
        ${whereSQL}
      )
      SELECT PERSON_CODE, COMPANY_CODE, PREFIX, FNAME, LNAME, DESIG, DEPT, MOBILE, PERSON_EMAIL,
             DOB, REMARKS, MANAGEMENT_REMARKS, USER_CODE, ADDRESS, UPDATED_DATE, CREATED_DATE
      FROM PersonData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.DEVP_COMP_PERSON
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
        SELECT PERSON_CODE, COMPANY_CODE, PREFIX, FNAME, LNAME, DESIG, DEPT, MOBILE, PERSON_EMAIL,
        DOB, REMARKS, CONTACTDATE, MANAGEMENT_REMARKS, USER_CODE, ADDRESS, CUPD_REMARK
        FROM DEVP_COMP_PERSON
        WHERE PERSON_CODE = @PERSON_CODE
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
      mobiles,
      emails,
      dob,
      remarks,
      management_remarks,
      contactdate,
      addresses,
      cupd_remark,
      usercode
    } = req.body;

    if (!personCode) {
      return res.status(400).json({
        success: false,
        message: "Person code is required for update",
      });
    }

    const UPDATED_DATE = new Date();
    await transaction.begin();

    await new sql.Request(transaction)
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .input("COMPANY_CODE", sql.VarChar(50), companycode)
      .input("PREFIX", sql.VarChar(20), salutation || "")
      .input("FNAME", sql.VarChar(40), firstname || "")
      .input("LNAME", sql.VarChar(40), lastname || "")
      .input("DESIG", sql.NVarChar(sql.MAX), JSON.stringify(designations || []))
      .input("DEPT", sql.NVarChar(sql.MAX), JSON.stringify(departments || []))
      .input("MOBILE", sql.VarChar(35), JSON.stringify(mobiles || []))
      .input("PERSON_EMAIL", sql.VarChar(60), JSON.stringify(emails || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("ADDRESS", sql.VarChar(75), JSON.stringify(addresses || []))
      .input("CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        UPDATE DEVP_COMP_PERSON
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
          CUPD_REMARK = @CUPD_REMARK,
          UPDATED_DATE = @UPDATED_DATE
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
      .input("MOBILE", sql.VarChar(35), JSON.stringify(mobiles || []))
      .input("PERSON_EMAIL", sql.VarChar(60), JSON.stringify(emails || []))
      .input("DOB", sql.SmallDateTime, dob || null)
      .input("REMARKS", sql.VarChar(75), remarks || "")
      .input("CONTACTDATE", sql.SmallDateTime, contactdate || null)
      .input("MANAGEMENT_REMARKS", sql.VarChar(75), management_remarks || "")
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("ADDRESS", sql.VarChar(75), JSON.stringify(addresses || []))
      .input("CUPD_REMARK", sql.VarChar(50), cupd_remark || "")
      .input("UPDATED_DATE", sql.DateTime, UPDATED_DATE)
      .query(`
        INSERT INTO DEVP_COMP_PERSON_UPDATE_HISTORY (
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
          CUPD_REMARK,
          UPDATED_DATE
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
          @CUPD_REMARK,
          @UPDATED_DATE
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
        SELECT * 
        FROM DEVP_COMP_PERSON_EXH_HISTORY
        WHERE PERSON_CODE = @PERSON_CODE
        ORDER BY CREATED_DATE DESC
        OFFSET @OFFSET ROWS
        FETCH NEXT @LIMIT ROWS ONLY
      `);

    const countResult = await pool.request()
      .input("PERSON_CODE", sql.VarChar(50), personCode)
      .query(`
        SELECT COUNT(*) AS total
        FROM DEVP_COMP_PERSON_EXH_HISTORY
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






