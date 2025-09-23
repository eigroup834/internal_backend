const { poolPromise } = require("../db");
const sql = require("mssql");
const ExcelJS = require('exceljs');

const generateCompanyCode = (name) => {
  const prefix = name.replace(/[^A-Z0-9]/gi, "").substring(0, 4).toUpperCase();
  const unique = Date.now().toString().slice(-6);
  return prefix + unique;
};

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
      if (val && val.trim() !== "" && filterColumns[key]) {
        const col = filterColumns[key];

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

    console.log(query);

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
      remarks, specialremarks, country, state, city,
      segment, usercode, sourcecode, sourceperson, sourcetype, oldname
    } = req.body;

    const COMPANY_CODE = generateCompanyCode(name);
    const CREATED_DATE = new Date();

    await transaction.begin();
    const request = new sql.Request(transaction);

    await request
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

    await request
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), name)
      .input("OLDNAME", sql.NVarChar(255), oldname)
      .input("ADDRESS", sql.NVarChar(sql.MAX), JSON.stringify(addresses))
      .input("CITY", sql.NVarChar(100), city)
      .input("PINCODE", sql.VarChar(20), pincode)
      .input("STATE", sql.NVarChar(100), state)
      .input("COUNTRY", sql.NVarChar(100), country)
      .input("PHONES", sql.VarChar(sql.MAX), JSON.stringify(phones))
      .input("EMAIL", sql.NVarChar(255), email)
      .input("WEBSITE", sql.NVarChar(255), website)
      .query(`
        INSERT INTO DEVP_COMPANY_DETAIL (COMPANY_CODE, COMPANY_NAME, DIVISION, OLDNAME, ADDRESS, CITY, PINCODE, STATE, COUNTRY, PHONES, EMAIL, WEBSITE, CREATED_DATE)
        VALUES (@COMPANY_CODE, @COMPANY_NAME, @DIVISION, @OLDNAME, @ADDRESS, @CITY, @PINCODE, @STATE, @COUNTRY, @PHONES, @EMAIL, @WEBSITE, @CREATED_DATE)
      `);

    await request
      .input("SEGMENT", sql.NVarChar(255), segment)
      .input("SEG_CODE", sql.VarChar(50), segment)
      .query(`
        INSERT INTO DEVP_COMP_SEGMENT_MAP (COMPANY_CODE, SEGMENT, SEG_CODE)
        VALUES (@COMPANY_CODE, @SEGMENT, @SEG_CODE)
      `);

    await request
      .input("SOURCE_PERSON", sql.NVarChar(255), sourceperson)
      .input("SOURCE_TYPE", sql.NVarChar(50), sourcetype)
      .query(`
        INSERT INTO DEVP_DATA_SOURCE (SOURCE_CODE, SOURCE_PERSON, SOURCE_TYPE, CREATED_DATE, COMPANY_CODE)
        VALUES (@SOURCE_CODE, @SOURCE_PERSON, @SOURCE_TYPE, @CREATED_DATE, @COMPANY_CODE)
      `);

    await request
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`
        UPDATE DEVP_USER
        SET DATA_COUNT = ISNULL(DATA_COUNT, 0) + 1
        WHERE USER_CODE = @USER_CODE
      `);

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
      remarks, specialremarks, country, state, city,
      segment, usercode, sourcecode, sourceperson, sourcetype, oldname
    } = req.body;

    if (!companyCode) {
      return res.status(400).json({ success: false, message: "Company code is required for update" });
    }

    const UPDATED_DATE = new Date();

    await transaction.begin();
    const request = new sql.Request(transaction);

    await request
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

    await request
      .input("COMPANY_NAME", sql.NVarChar(255), name)
      .input("DIVISION", sql.NVarChar(255), name)
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

    await request
      .input("SEGMENT", sql.NVarChar(255), segment)
      .input("SEG_CODE", sql.VarChar(50), segment)
      .query(`
        UPDATE DEVP_COMP_SEGMENT_MAP
        SET SEGMENT = @SEGMENT,
            SEG_CODE = @SEG_CODE
        WHERE COMPANY_CODE = @COMPANY_CODE
      `);

    await request
      .input("SOURCE_CODE", sql.VarChar(50), sourcecode)
      .input("SOURCE_PERSON", sql.NVarChar(255), sourceperson)
      .input("SOURCE_TYPE", sql.NVarChar(50), sourcetype)
      .query(`
        UPDATE DEVP_DATA_SOURCE
        SET SOURCE_PERSON = @SOURCE_PERSON,
            SOURCE_TYPE = @SOURCE_TYPE
        WHERE COMPANY_CODE = @COMPANY_CODE
          AND SOURCE_CODE = @SOURCE_CODE
      `);

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Company updated successfully",
      companyCode: companyCode,
    });

  } catch (err) {
    console.error("Error updating company:", err);
    if (transaction._aborted !== true) {
      await transaction.rollback();
    }
    res.status(500).json({ success: false, error: err.message });
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
        SELECT m.COMPANY_CODE, d.COMPANY_NAME, d.DIVISION, d.OLDNAME, d.ADDRESS, d.CITY, d.STATE, d.COUNTRY, d.PINCODE,
               d.PHONES, d.EMAIL, d.WEBSITE, s.SEGMENT, s.SEG_CODE, ds.SOURCE_CODE, ds.SOURCE_PERSON, ds.SOURCE_TYPE,
               m.REMARKS, m.MANAGEMENT_REMARKS
        FROM DEVP_MASTER m
        LEFT JOIN DEVP_COMPANY_DETAIL d ON m.COMPANY_CODE = d.COMPANY_CODE
        LEFT JOIN DEVP_COMP_SEGMENT_MAP s ON m.COMPANY_CODE = s.COMPANY_CODE
        LEFT JOIN DEVP_DATA_SOURCE ds ON m.COMPANY_CODE = ds.COMPANY_CODE
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
    const pool = await poolPromise;
    const request = pool.request();

    let whereClauses = [];

    if (filters.COUNTRY) {
      whereClauses.push("UPPER(c.COUNTRY) LIKE UPPER(@COUNTRY)");
      request.input("COUNTRY", `%${filters.COUNTRY}%`);
    }
    if (filters.STATE) {
      whereClauses.push("UPPER(c.STATE) LIKE UPPER(@STATE)");
      request.input("STATE", `%${filters.STATE}%`);
    }
    if (filters.CITY) {
      whereClauses.push("UPPER(c.CITY) LIKE UPPER(@CITY)");
      request.input("CITY", `%${filters.CITY}%`);
    }
    if (filters.INDUSTRY) {
      whereClauses.push("UPPER(s.INDUSTRY) LIKE UPPER(@INDUSTRY)");
      request.input("INDUSTRY", `%${filters.INDUSTRY}%`);
    }
    if (filters.SEGMENT) {
      whereClauses.push("UPPER(m.SEG_CODE) = UPPER(@SEGMENT)");
      request.input("SEGMENT", filters.SEGMENT);
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const query = `
      SELECT DISTINCT c.COMPANY_CODE, c.COMPANY_NAME, c.ADDRESS, c.CITY, c.STATE, c.COUNTRY, c.PINCODE, c.PHONES
      FROM dbo.DEVP_COMPANY_DETAIL c
      INNER JOIN dbo.DEVP_COMP_SEGMENT_MAP m ON c.COMPANY_CODE = m.COMPANY_CODE
      INNER JOIN dbo.DEVP_INDSEGMENT s ON m.SEG_CODE = s.SEG_CODE
      ${whereSQL}
      ORDER BY c.COMPANY_CODE ASC
    `;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: true
    });

    const worksheet = workbook.addWorksheet("Companies");

    worksheet.columns = [
      { header: "Company Code", key: "COMPANY_CODE", width: 20 },
      { header: "Company Name", key: "COMPANY_NAME", width: 30 },
      { header: "Address", key: "ADDRESS", width: 40 },
      { header: "City", key: "CITY", width: 20 },
      { header: "State", key: "STATE", width: 20 },
      { header: "Country", key: "COUNTRY", width: 20 },
      { header: "Pin Code", key: "PINCODE", width: 15 },
      { header: "Phones", key: "PHONES", width: 30 },
    ];

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Companies_${Date.now()}.xlsx`
    );

    const stream = pool.request().query(query);

    stream.then(result => {
      result.recordset.forEach(row => {
        worksheet.addRow({
          COMPANY_CODE: row.COMPANY_CODE,
          COMPANY_NAME: row.COMPANY_NAME,
          ADDRESS: row.ADDRESS,
          CITY: row.CITY,
          STATE: row.STATE,
          COUNTRY: row.COUNTRY,
          PINCODE: row.PINCODE || "N/A",
          PHONES: row.PHONES || ""
        }).commit();
      });

      worksheet.commit();
      workbook.commit();
    }).catch(err => {
      console.error("Export stream error:", err);
      res.status(500).json({ message: "Export failed" });
    });

  } catch (err) {
    console.error("Export Error:", err);
    res.status(500).json({ message: "Failed to export companies" });
  }
};




