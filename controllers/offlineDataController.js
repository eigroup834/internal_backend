const { poolPromise } = require("../db");
const sql = require("mssql");
const { TABLES } = require("../helper");

const generateSrlNo = () => {
  const rawNumber = Date.now() + Math.floor(Math.random() * 1000);
  const hexPart = rawNumber.toString(16).toUpperCase();
  return `OD${hexPart}`;
};

const INTEREST_FIELDS = [
  "ICT", "MOBILE_", "IOT_EMBDED", "FINTECH", "BC_SATCOM",
  "AI", "FUTURE_CITY", "MOBILITY", "GAMING", "START_UP",
];

const toMultiValueJson = (arr) => JSON.stringify(
  (Array.isArray(arr) ? arr : [])
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .slice(0, 3)
);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const findInvalidEmail = (arr, label) => {
  const invalid = (Array.isArray(arr) ? arr : [])
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .find(v => v && !EMAIL_REGEX.test(v));
  return invalid ? `${label} "${invalid}" is not a valid email address.` : null;
};

exports.getOfflineDataList = async (req, res) => {
  try {
    const { page = 1, limit = 15, search = "", searchBy = "FNAME" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    const searchableColumns = {
      FNAME: "FNAME",
      LNAME: "LNAME",
      FULLNAME: "(ISNULL(FNAME,'') + ' ' + ISNULL(LNAME,''))",
      COMPANY: "COMPANY",
      EMAIL: "PERSON_EMAIL",
      PHONE: "MOBILE_NUMBER",
      SRL_NO: "SRL_NO",
    };

    const pool = await poolPromise;
    const request = pool.request();
    let whereSQL = "WHERE 1=1";
    const term = (search || "").trim();
    if (term) {
      const col = searchableColumns[searchBy] || searchableColumns.FNAME;
      request.input("search", sql.NVarChar(200), `%${term}%`);
      whereSQL += ` AND ${col} LIKE @search`;
    }

    request.input("fromRow", sql.Int, offset + 1);
    request.input("toRow", sql.Int, offset + limitNum);

    const query = `
      WITH OfflineData AS (
        SELECT
          SRL_NO, [DATE], PREFIX, FNAME, LNAME, DESIGNATION, DEPARTMENT, COMPANY,
          CITY, STATE, COUNTRY, PERSON_EMAIL, MOBILE_NUMBER, SOURCE, SOURCE_PERSON, REMARKS, USER_CODE,
          ROW_NUMBER() OVER (ORDER BY [DATE] DESC, SRL_NO DESC) AS RowNum,
          COUNT(*) OVER() AS TotalCount
        FROM dbo.[${TABLES.OFFLINE_DATA}]
        ${whereSQL}
      )
      SELECT * FROM OfflineData
      WHERE RowNum BETWEEN @fromRow AND @toRow
      ORDER BY RowNum
    `;

    const result = await request.query(query);
    const rows = result.recordset;
    const total = rows.length > 0 ? rows[0].TotalCount : 0;
    rows.forEach(r => { delete r.RowNum; delete r.TotalCount; });

    res.json({ data: rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("getOfflineDataList error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getMyOfflineDataEntries = async (req, res) => {
  try {
    const userCode = req.user?.user_code;
    if (!userCode) return res.status(401).json({ error: "Unauthorized" });

    const ymd = (dt) => {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const earliest = new Date(today);
    earliest.setDate(earliest.getDate() - 10);

    let { date } = req.query;
    if (!date) date = ymd(today);

    const picked = new Date(`${date}T00:00:00`);
    if (isNaN(picked.getTime()) || picked > today || picked < earliest) {
      return res.status(400).json({ error: "Only the last 10 days are available." });
    }
    date = ymd(picked);

    const pool = await poolPromise;
    const result = await pool.request()
      .input("USER_CODE", sql.VarChar(100), userCode)
      .input("DATE", sql.Date, date)
      .query(`
        SELECT SRL_NO, [DATE], PREFIX, FNAME, LNAME, COMPANY, DESIGNATION,
               PERSON_EMAIL, MOBILE_NUMBER, SOURCE
        FROM dbo.[${TABLES.OFFLINE_DATA}]
        WHERE USER_CODE = @USER_CODE AND CAST([DATE] AS DATE) = @DATE
        ORDER BY [DATE] DESC
      `);

    res.json({ date, data: result.recordset });
  } catch (err) {
    console.error("getMyOfflineDataEntries error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getOfflineDataDetails = async (req, res) => {
  try {
    const { srlNo } = req.params;
    const pool = await poolPromise;
    const result = await pool.request()
      .input("SRL_NO", sql.VarChar(50), srlNo)
      .query(`SELECT * FROM dbo.[${TABLES.OFFLINE_DATA}] WHERE SRL_NO = @SRL_NO`);

    if (!result.recordset.length) {
      return res.status(404).json({ error: "Record not found" });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("getOfflineDataDetails error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.addOfflineData = async (req, res) => {
  try {
    const {
      prefix, fname, lname, designation, department, company,
      add1, add2, add3, city, state, pincode, country, website, socialLink,
      interests = {}, source, sourcePerson, remarks, companyEmail, personEmail, mobileNumber,
    } = req.body;

    if (!fname || !fname.trim()) {
      return res.status(400).json({ success: false, message: "First name is required." });
    }
    if (!company || !company.trim()) {
      return res.status(400).json({ success: false, message: "Company is required." });
    }
    const emailError = findInvalidEmail(personEmail, "Person Email") || findInvalidEmail(companyEmail, "Company Email");
    if (emailError) {
      return res.status(400).json({ success: false, message: emailError });
    }

    const SRL_NO = generateSrlNo();
    const userCode = req.user?.user_code;

    const pool = await poolPromise;
    const request = pool.request();
    request.input("SRL_NO", sql.VarChar(50), SRL_NO);
    request.input("DATE", sql.SmallDateTime, new Date());
    request.input("PREFIX", sql.VarChar(50), prefix || "");
    request.input("FNAME", sql.VarChar(100), fname.trim());
    request.input("LNAME", sql.VarChar(100), lname || "");
    request.input("DESIGNATION", sql.NVarChar(sql.MAX), designation || "");
    request.input("DEPARTMENT", sql.NVarChar(sql.MAX), department || "");
    request.input("COMPANY", sql.NVarChar(sql.MAX), company.trim());
    request.input("ADD_1", sql.NVarChar(sql.MAX), add1 || "");
    request.input("ADD_2", sql.NVarChar(sql.MAX), add2 || "");
    request.input("ADD_3", sql.NVarChar(sql.MAX), add3 || "");
    request.input("CITY", sql.VarChar(100), city || "");
    request.input("STATE", sql.VarChar(100), state || "");
    request.input("PIN_CODE", sql.VarChar(20), pincode || "");
    request.input("COUNTRY", sql.VarChar(100), country || "");
    request.input("WEBSITE", sql.NVarChar(sql.MAX), website || "");
    request.input("SOCIAL_LINK", sql.NVarChar(sql.MAX), socialLink || "");
    INTEREST_FIELDS.forEach(f => request.input(f, sql.VarChar(50), interests[f] ? "Yes" : null));
    request.input("SOURCE", sql.VarChar(100), source || "");
    request.input("SOURCE_PERSON", sql.VarChar(255), sourcePerson || "");
    request.input("REMARKS", sql.VarChar(255), remarks || "");
    request.input("USER_CODE", sql.VarChar(100), userCode);
    request.input("COMPANY_EMAIL", sql.NVarChar(sql.MAX), toMultiValueJson(companyEmail));
    request.input("PERSON_EMAIL", sql.NVarChar(sql.MAX), toMultiValueJson(personEmail));
    request.input("MOBILE_NUMBER", sql.NVarChar(sql.MAX), toMultiValueJson(mobileNumber));

    await request.query(`
      INSERT INTO dbo.[${TABLES.OFFLINE_DATA}]
        (SRL_NO, [DATE], PREFIX, FNAME, LNAME, DESIGNATION, DEPARTMENT, COMPANY,
         ADD_1, ADD_2, ADD_3, CITY, STATE, PIN_CODE, COUNTRY, WEBSITE, SOCIAL_LINK,
         ${INTEREST_FIELDS.join(", ")}, SOURCE, SOURCE_PERSON, REMARKS, USER_CODE, COMPANY_EMAIL, PERSON_EMAIL, MOBILE_NUMBER)
      VALUES
        (@SRL_NO, @DATE, @PREFIX, @FNAME, @LNAME, @DESIGNATION, @DEPARTMENT, @COMPANY,
         @ADD_1, @ADD_2, @ADD_3, @CITY, @STATE, @PIN_CODE, @COUNTRY, @WEBSITE, @SOCIAL_LINK,
         ${INTEREST_FIELDS.map(f => `@${f}`).join(", ")}, @SOURCE, @SOURCE_PERSON, @REMARKS, @USER_CODE, @COMPANY_EMAIL, @PERSON_EMAIL, @MOBILE_NUMBER)
    `);

    res.status(201).json({ success: true, message: "Record saved successfully", srlNo: SRL_NO });
  } catch (err) {
    console.error("addOfflineData error:", err);
    res.status(500).json({ success: false, error: err.message || "Server Error" });
  }
};

exports.updateOfflineData = async (req, res) => {
  try {
    const { srlNo } = req.params;
    const {
      prefix, fname, lname, designation, department, company,
      add1, add2, add3, city, state, pincode, country, website, socialLink,
      interests = {}, source, sourcePerson, remarks, companyEmail, personEmail, mobileNumber,
    } = req.body;

    if (!fname || !fname.trim()) {
      return res.status(400).json({ success: false, message: "First name is required." });
    }
    if (!company || !company.trim()) {
      return res.status(400).json({ success: false, message: "Company is required." });
    }
    const emailError = findInvalidEmail(personEmail, "Person Email") || findInvalidEmail(companyEmail, "Company Email");
    if (emailError) {
      return res.status(400).json({ success: false, message: emailError });
    }

    const pool = await poolPromise;
    const request = pool.request();
    request.input("SRL_NO", sql.VarChar(50), srlNo);
    request.input("PREFIX", sql.VarChar(50), prefix || "");
    request.input("FNAME", sql.VarChar(100), fname.trim());
    request.input("LNAME", sql.VarChar(100), lname || "");
    request.input("DESIGNATION", sql.NVarChar(sql.MAX), designation || "");
    request.input("DEPARTMENT", sql.NVarChar(sql.MAX), department || "");
    request.input("COMPANY", sql.NVarChar(sql.MAX), company.trim());
    request.input("ADD_1", sql.NVarChar(sql.MAX), add1 || "");
    request.input("ADD_2", sql.NVarChar(sql.MAX), add2 || "");
    request.input("ADD_3", sql.NVarChar(sql.MAX), add3 || "");
    request.input("CITY", sql.VarChar(100), city || "");
    request.input("STATE", sql.VarChar(100), state || "");
    request.input("PIN_CODE", sql.VarChar(20), pincode || "");
    request.input("COUNTRY", sql.VarChar(100), country || "");
    request.input("WEBSITE", sql.NVarChar(sql.MAX), website || "");
    request.input("SOCIAL_LINK", sql.NVarChar(sql.MAX), socialLink || "");
    INTEREST_FIELDS.forEach(f => request.input(f, sql.VarChar(50), interests[f] ? "Yes" : null));
    request.input("SOURCE", sql.VarChar(100), source || "");
    request.input("SOURCE_PERSON", sql.VarChar(255), sourcePerson || "");
    request.input("REMARKS", sql.VarChar(255), remarks || "");
    request.input("COMPANY_EMAIL", sql.NVarChar(sql.MAX), toMultiValueJson(companyEmail));
    request.input("PERSON_EMAIL", sql.NVarChar(sql.MAX), toMultiValueJson(personEmail));
    request.input("MOBILE_NUMBER", sql.NVarChar(sql.MAX), toMultiValueJson(mobileNumber));

    const result = await request.query(`
      UPDATE dbo.[${TABLES.OFFLINE_DATA}]
      SET PREFIX = @PREFIX, FNAME = @FNAME, LNAME = @LNAME,
          DESIGNATION = @DESIGNATION, DEPARTMENT = @DEPARTMENT, COMPANY = @COMPANY,
          ADD_1 = @ADD_1, ADD_2 = @ADD_2, ADD_3 = @ADD_3, CITY = @CITY, STATE = @STATE,
          PIN_CODE = @PIN_CODE, COUNTRY = @COUNTRY, WEBSITE = @WEBSITE, SOCIAL_LINK = @SOCIAL_LINK,
          ${INTEREST_FIELDS.map(f => `${f} = @${f}`).join(", ")},
          SOURCE = @SOURCE, SOURCE_PERSON = @SOURCE_PERSON, REMARKS = @REMARKS, COMPANY_EMAIL = @COMPANY_EMAIL,
          PERSON_EMAIL = @PERSON_EMAIL, MOBILE_NUMBER = @MOBILE_NUMBER
      WHERE SRL_NO = @SRL_NO
    `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: "Record not found" });
    }
    res.json({ success: true, message: "Record updated successfully", srlNo });
  } catch (err) {
    console.error("updateOfflineData error:", err);
    res.status(500).json({ success: false, error: err.message || "Server Error" });
  }
};
