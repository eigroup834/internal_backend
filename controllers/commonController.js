const { Country, State, City } = require("country-state-city");
const { poolPromise, sql } = require("../db");
const { TABLES } = require('../helper');
const ExcelJS = require("exceljs");

const generateEventCode = () => {
  const rawNumber = Date.now() + Math.floor(Math.random() * 1000);
  const hexPart = rawNumber.toString(16).toUpperCase();
  const eventCode = `EV${hexPart}`;
  return eventCode;
}

exports.getCountries = async (req, res) => {
  try {
    const countries = Country.getAllCountries().map(c => ({
      name: c.name,
      isoCode: c.isoCode,
      phonecode: c.phonecode,
      flag: c.flag,
    }));
    res.json(countries);
  } catch (err) {
    console.error("Country fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getStates = async (req, res) => {
  try {
    const { country } = req.query;
    if (!country) return res.json([]);

    const states = State.getStatesOfCountry(country).map(s => ({
      name: s.name,
      isoCode: s.isoCode,
    }));
    res.json(states);
  } catch (err) {
    console.error("State fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getCities = async (req, res) => {
  try {
    const { country, state } = req.query;
    if (!country || !state) return res.json([]);

    const cities = City.getCitiesOfState(country, state).map(c => ({
      name: c.name,
    }));
    res.json(cities);
  } catch (err) {
    console.error("City fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getEditors = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      sortBy = "USER_CODE",
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

    const allowedSortColumns = ["ID", "USERNAME", "USER_CODE", "EMAIL", "PHONE", "DEPARTMENT", "ACCESS_LEVEL", "ACTIVE"];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : "USER_CODE";
    const sortDir = sortOrder.toUpperCase() === "DESC" ? "DESC" : "ASC";

    const allowedFilterColumns = ["ID", "USERNAME", "USER_CODE", "EMAIL", "PHONE", "DEPARTMENT", "ACCESS_LEVEL", "ACTIVE"];
    const whereClauses = [];
    const request = (await poolPromise).request();
    if (!("ACTIVE" in filterObj)) {
      whereClauses.push("[ACTIVE] = 1");
    }

    if (search) {
      const likeClauses = [
        "[USERNAME] LIKE @search1",
        "[USER_CODE] LIKE @search2",
        "[EMAIL] LIKE @search3",
        "[PHONE] LIKE @search4",
      ];
      whereClauses.push("(" + likeClauses.join(" OR ") + ")");
      request.input("search1", `%${search}%`);
      request.input("search2", `%${search}%`);
      request.input("search3", `%${search}%`);
      request.input("search4", `%${search}%`);
    }

    for (const key in filterObj) {
      if (allowedFilterColumns.includes(key) && filterObj[key] !== "") {
        whereClauses.push(`[${key}] = @${key}`);
        request.input(key, filterObj[key]);
      }
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const query = `
      WITH UserData AS (
        SELECT *,
               ROW_NUMBER() OVER (ORDER BY [${sortColumn}] ${sortDir}) AS RowNum
        FROM dbo.[${TABLES.USER}]
        ${whereSQL}
      )
      SELECT *
      FROM UserData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.USER}]
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
    console.error("User fetch error:", err?.originalError || err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const pool = await poolPromise;

    const categoryResult = await pool.request().query(`
      SELECT CATEGORY_TYPE, LABEL, VALUE
      FROM dbo.[${TABLES.CATEGORY}]
      WHERE ACTIVE = 1
    `);

    const sourcePersonResult = await pool.request().query(`
      SELECT TOP (1000) [ID], [NAME], [STATUS], [CREATED_DATE], [UPDATED_DATE]
      FROM [Eiplsql_5.0].[dbo].[SOURCE_PERSON]
    `);

    const rows = categoryResult.recordset;

    const groupedCategories = rows.reduce((acc, row) => {
      if (!acc[row.CATEGORY_TYPE]) {
        acc[row.CATEGORY_TYPE] = [];
      }
      const item = { label: row.LABEL, value: row.VALUE };
      acc[row.CATEGORY_TYPE].push(item);
      return acc;
    }, {});

    const SOURCEPERSON = sourcePersonResult.recordset;

    const response = {
      ...groupedCategories,
      SOURCEPERSON
    };
    res.json(response);

  } catch (err) {
    console.error("Category fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getStats = async (req, res) => {
  try {
    const { user_code } = req.query;
    if (!user_code) {
      return res.status(400).json({ error: "user_code is required" });
    }

    const pool = await poolPromise;

    const companyQuery = `
      SELECT 
        COUNT(*) AS Total,
        SUM(CASE WHEN CAST(c.CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today
      FROM dbo.[${TABLES.COMPANY_DETAIL}] c
      INNER JOIN dbo.[${TABLES.COMP_MASTER}] m ON c.COMPANY_CODE = m.COMPANY_CODE
      WHERE m.USER_CODE = @user_code
    `;

    const personQuery = `
      SELECT 
        COUNT(*) AS Total,
        SUM(CASE WHEN CAST(CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today
      FROM dbo.[${TABLES.COMP_PERSON}]
      WHERE USER_CODE = @user_code
    `;

    const [companyResult, personResult] = await Promise.all([
      pool.request().input("user_code", sql.VarChar(50), user_code).query(companyQuery),
      pool.request().input("user_code", sql.VarChar(50), user_code).query(personQuery),
    ]);

    const companyStats = companyResult.recordset[0];
    const personStats = personResult.recordset[0];

    res.json({
      CompaniesToday: companyStats.Today || 0,
      CompaniesMonth: companyStats.Total || 0,
      PersonsToday: personStats.Today || 0,
      PersonsMonth: personStats.Total || 0,
    });
  } catch (err) {
    console.error("getStats error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getActivity = async (req, res) => {
  try {
    const { user_code, startDate, endDate } = req.query;
    if (!user_code) return res.status(400).json({ error: "user_code is required" });

    const pool = await poolPromise;
    let dateFilter = "";

    if (startDate && endDate) {
      dateFilter = `AND CAST(c.CREATED_DATE AS DATE) BETWEEN '${startDate}' AND '${endDate}'`;
    }

    const companyQuery = `
      SELECT 
        CAST(c.CREATED_DATE AS DATE) AS date, 
        COUNT(*) AS companies
      FROM dbo.[${TABLES.COMPANY_DETAIL}] c
      INNER JOIN dbo.[${TABLES.COMP_MASTER}] m ON c.COMPANY_CODE = m.COMPANY_CODE
      WHERE m.USER_CODE = @user_code ${dateFilter}
      GROUP BY CAST(c.CREATED_DATE AS DATE)
      ORDER BY date
    `;

    const personQuery = `
      SELECT 
        CAST(CREATED_DATE AS DATE) AS date, 
        COUNT(*) AS persons
      FROM dbo.[${TABLES.COMP_PERSON}]
      WHERE USER_CODE = @user_code ${dateFilter}
      GROUP BY CAST(CREATED_DATE AS DATE)
      ORDER BY date
    `;

    const [companyRes, personRes] = await Promise.all([
      pool.request().input("user_code", sql.VarChar(50), user_code).query(companyQuery),
      pool.request().input("user_code", sql.VarChar(50), user_code).query(personQuery),
    ]);

    const activityMap = {};

    companyRes.recordset.forEach((row) => {
      activityMap[row.date] = { date: row.date, companies: row.companies, persons: 0 };
    });

    personRes.recordset.forEach((row) => {
      if (activityMap[row.date]) {
        activityMap[row.date].persons = row.persons;
      } else {
        activityMap[row.date] = { date: row.date, companies: 0, persons: row.persons };
      }
    });

    const merged = Object.values(activityMap).sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json(merged);
  } catch (err) {
    console.error("getActivity error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getEvents = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "", page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT ID, EVENT_NAME, EVENT_YEAR, EVENT_CODE, EVENT_LOCATION, CREATED_DATE, USER_CODE, ATTENDEE
      FROM dbo.[${TABLES.EVENTS}]
    `;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.EVENTS}]
    `;

    if (search.trim() !== "") {
      query += ` WHERE (EVENT_NAME LIKE '%' + @search + '%' OR EVENT_CODE LIKE '%' + @search + '%')`;
      countQuery += ` WHERE (EVENT_NAME LIKE '%' + @search + '%' OR EVENT_CODE LIKE '%' + @search + '%')`;
    }

    query += `
      ORDER BY CREATED_DATE DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const request = pool.request();
    request.input("search", sql.VarChar(100), search);
    request.input("offset", sql.Int, offset);
    request.input("limit", sql.Int, parseInt(limit));

    const [dataResult, countResult] = await Promise.all([
      request.query(query),
      pool.request().input("search", sql.VarChar(100), search).query(countQuery),
    ]);

    const events = dataResult.recordset.map(item => ({
      ...item,
      ATTENDEE: item.ATTENDEE ? JSON.parse(item.ATTENDEE) : []
    }));

    res.json({
      data: events,
      total: countResult.recordset[0].total,
    });
  } catch (err) {
    console.error("getEvents error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateEventAttendee = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { id } = req.params;

    let { EVENT_NAME, EVENT_YEAR, EVENT_LOCATION, ATTENDEE = [] } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    if (!EVENT_NAME || !EVENT_YEAR || !EVENT_LOCATION) {
      return res.status(400).json({ error: "Event name, year, and location are required." });
    }

    const attendeeJson = JSON.stringify(ATTENDEE);

    const query = `
      UPDATE dbo.[${TABLES.EVENTS}]
      SET EVENT_NAME = @EVENT_NAME,
          EVENT_YEAR = @EVENT_YEAR,
          EVENT_LOCATION = @EVENT_LOCATION,
          ATTENDEE = @ATTENDEE,
          UPDATED_DATE = GETDATE()
      WHERE ID = @ID
    `;

    const request = pool.request();
    request.input("ID", sql.Int, id);
    request.input("EVENT_NAME", sql.VarChar(255), EVENT_NAME);
    request.input("EVENT_YEAR", sql.Int, parseInt(EVENT_YEAR, 10));
    request.input("EVENT_LOCATION", sql.VarChar(255), EVENT_LOCATION);
    request.input("ATTENDEE", sql.NVarChar(sql.MAX), attendeeJson);

    await request.query(query);

    res.status(200).json({ message: "Exhibition updated successfully" });

  } catch (err) {
    console.error("updateEventAttendee error:", err);
    return res.status(500).json({
      error: "Database Error",
      details: err.originalError?.info?.message || err.message
    });
  }
};

exports.getEventsAttendee = async (req, res) => {
  try {
    const pool = await poolPromise;
    const search = req.query.search || "";

    let query = `
      SELECT NAME
      FROM dbo.[${TABLES.EVENTS_ATTENDEE}]
    `;

    if (search.trim() !== "") {
      query += ` WHERE NAME LIKE '%' + @search + '%'`;
    }

    query += ` ORDER BY NAME`;

    const request = pool.request();
    request.input("search", sql.VarChar(100), search);

    const result = await request.query(query);

    res.json({
      data: result.recordset,
      total: result.recordset.length
    });

  } catch (err) {
    console.error("getEventsAttendee error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getEventsWithSearch = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "" } = req.query;

    let query = `
      SELECT EVENT_NAME, EVENT_YEAR, EVENT_CODE, EVENT_LOCATION, CREATED_DATE, USER_CODE, ATTENDEE
      FROM dbo.[${TABLES.EVENTS}]
    `;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.EVENTS}]
    `;

    const request = pool.request();
    const countRequest = pool.request();

    if (search.trim() !== "") {
      query += ` WHERE EVENT_NAME LIKE '%' + @search + '%' OR EVENT_CODE LIKE '%' + @search + '%'`;
      countQuery += ` WHERE EVENT_NAME LIKE '%' + @search + '%' OR EVENT_CODE LIKE '%' + @search + '%'`;

      request.input("search", sql.VarChar(100), search);
      countRequest.input("search", sql.VarChar(100), search);
    }

    query += ` ORDER BY EVENT_NAME`;

    const [dataResult, countResult] = await Promise.all([
      request.query(query),
      countRequest.query(countQuery)
    ]);

    dataResult.recordset = dataResult.recordset.map(ev => {
      let att = ev.ATTENDEE;

      if (typeof att === "string") {
        try {
          att = JSON.parse(att);
        } catch {
          att = att.split(",").map(x => x.replace(/[\[\]"]/g, "").trim());
        }
      }

      return {
        ...ev,
        ATTENDEE: Array.isArray(att) ? att : []
      };
    });

    res.json({
      data: dataResult.recordset,
      total: countResult.recordset[0].total
    });

  } catch (err) {
    console.error("getEvents error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addEvent = async (req, res) => {
  try {
    const pool = await poolPromise;

    let {
      EVENT_NAME,
      EVENT_YEAR,
      EVENT_LOCATION,
      USER_CODE,
      ATTENDEE = []
    } = req.body;

    EVENT_YEAR = parseInt(EVENT_YEAR);

    if (!EVENT_NAME || !EVENT_YEAR || !EVENT_LOCATION || !USER_CODE) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const attendeeJson = JSON.stringify(ATTENDEE || []);

    if (isNaN(EVENT_YEAR)) {
      return res.status(400).json({ error: "EVENT_YEAR must be a valid number." });
    }

    const duplicateCheckQuery = `
      SELECT COUNT(*) AS count
      FROM dbo.[${TABLES.EVENTS}]
      WHERE EVENT_NAME = @EVENT_NAME AND EVENT_YEAR = @EVENT_YEAR
    `;

    const dupCheck = await pool.request()
      .input("EVENT_NAME", sql.VarChar(255), EVENT_NAME)
      .input("EVENT_YEAR", sql.Int, EVENT_YEAR)
      .query(duplicateCheckQuery);

    if (dupCheck.recordset[0].count > 0) {
      return res.status(409).json({
        error: "An event with this name and year already exists."
      });
    }

    let EVENT_CODE;
    let codeExists = true;
    while (codeExists) {
      EVENT_CODE = generateEventCode();
      const chk = await pool.request()
        .input("EVENT_CODE", sql.VarChar(100), EVENT_CODE)
        .query(`SELECT 1 FROM dbo.[${TABLES.EVENTS}] WHERE EVENT_CODE = @EVENT_CODE`);
      codeExists = chk.recordset.length > 0;
    }

    const query = `
      INSERT INTO dbo.[${TABLES.EVENTS}]
        (EVENT_NAME, EVENT_CODE, EVENT_YEAR, EVENT_LOCATION,
        ATTENDEE, CREATED_DATE, UPDATED_DATE, USER_CODE)
      VALUES
        (@EVENT_NAME, @EVENT_CODE, @EVENT_YEAR, @EVENT_LOCATION,
         @ATTENDEE, GETDATE(), GETDATE(), @USER_CODE);

      SELECT SCOPE_IDENTITY() AS newId;
    `;

    const request = pool.request();
    request.input("EVENT_NAME", sql.VarChar(255), EVENT_NAME);
    request.input("EVENT_CODE", sql.VarChar(100), EVENT_CODE);
    request.input("EVENT_YEAR", sql.Int, EVENT_YEAR);
    request.input("EVENT_LOCATION", sql.VarChar(255), EVENT_LOCATION);
    request.input("ATTENDEE", sql.NVarChar(sql.MAX), attendeeJson);
    request.input("USER_CODE", sql.VarChar(100), USER_CODE);

    const result = await request.query(query);

    res.status(201).json({
      message: "Event added successfully",
      eventId: result.recordset[0].newId,
      EVENT_CODE
    });

  } catch (err) {
    console.error("addEvent error:", err);
    return res.status(500).json({
      error: "Database Error",
      details: err.originalError?.info?.message || err.message
    });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;

    const check = await pool.request()
      .input("ID", sql.Int, id)
      .query(`SELECT COUNT(*) AS cnt FROM dbo.[${TABLES.EVENTS}] WHERE ID = @ID`);

    if (check.recordset[0].cnt === 0) {
      return res.status(404).json({ error: "Exhibition not found." });
    }

    await pool.request()
      .input("ID", sql.Int, id)
      .query(`DELETE FROM dbo.[${TABLES.EVENTS}] WHERE ID = @ID`);

    res.json({ message: "Exhibition deleted successfully" });
  } catch (err) {
    console.error("deleteEvent error:", err);
    res.status(500).json({
      error: "Database Error",
      details: err.originalError?.info?.message || err.message
    });
  }
};

exports.getTags = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "", page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT TAG_CODE, TAG_NAME, CREATED_DATE, USER_CODE, ACTIVE
      FROM dbo.[${TABLES.TAGS}]
      WHERE 1=1
    `;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.TAGS}]
      WHERE 1=1
    `;

    if (search.trim() !== "") {
      query += ` AND (TAG_NAME LIKE '%' + @search + '%' OR TAG_CODE LIKE '%' + @search + '%')`;
      countQuery += ` AND (TAG_NAME LIKE '%' + @search + '%' OR TAG_CODE LIKE '%' + @search + '%')`;
    }

    query += `
      ORDER BY CREATED_DATE DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const request = pool.request();
    request.input("search", sql.VarChar(100), search);
    request.input("offset", sql.Int, offset);
    request.input("limit", sql.Int, parseInt(limit));

    const [dataResult, countResult] = await Promise.all([
      request.query(query),
      pool.request()
        .input("search", sql.VarChar(100), search)
        .query(countQuery)
    ]);

    res.json({
      data: dataResult.recordset,
      total: countResult.recordset[0].total,
    });

  } catch (err) {
    console.error("getTags error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addTags = async (req, res) => {
  try {
    const { TAG_NAME, ACTIVE, usercode } = req.body;

    if (!TAG_NAME) {
      return res.status(400).json({ error: "Tagname is required" });
    }

    if (!usercode) {
      return res.status(400).json({ error: "User code is required" });
    }

    const pool = await poolPromise;

    const existing = await pool.request()
      .input("TAG_NAME", sql.VarChar(100), TAG_NAME)
      .query(`
        SELECT TAG_CODE, ACTIVE 
        FROM dbo.${TABLES.TAGS}
        WHERE TAG_NAME = @TAG_NAME
      `);

    if (existing.recordset.length > 0) {
      const row = existing.recordset[0];
      return res.status(409).json({ error: "Tagname already exists" });
    }

    let TAG_CODE;
    let exists = true;

    while (exists) {
      TAG_CODE = "HE" + Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .toUpperCase()
        .padStart(8, "0");

      const chk = await pool.request()
        .input("TAG_CODE", sql.VarChar(50), TAG_CODE)
        .query(`SELECT 1 FROM dbo.${TABLES.TAGS} WHERE TAG_CODE = @TAG_CODE`);

      exists = chk.recordset.length > 0;
    }

    await pool.request()
      .input("TAG_NAME", sql.VarChar(100), TAG_NAME)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("TAG_CODE", sql.VarChar(50), TAG_CODE)
      .input("ACTIVE", sql.Bit, ACTIVE ?? 1)
      .query(`
        INSERT INTO dbo.${TABLES.TAGS} (TAG_NAME, USER_CODE, ACTIVE, TAG_CODE)
        VALUES (@TAG_NAME, @USER_CODE, @ACTIVE, @TAG_CODE)
      `);

    return res.status(200).json({
      success: true,
      message: "Tag created successfully"
    });

  } catch (err) {
    console.error("addTags error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.updateTag = async (req, res) => {
  try {
    const { tagCode } = req.params;
    const { TAG_NAME, ACTIVE, usercode } = req.body;

    if (!TAG_NAME) {
      return res.status(400).json({ error: "Tag name is required" });
    }

    const pool = await poolPromise;
    await pool.request()
      .input("TAG_NAME", sql.VarChar(100), TAG_NAME)
      .input("ACTIVE", sql.Bit, ACTIVE)
      .input("TAG_CODE", sql.VarChar(50), tagCode)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`
        UPDATE dbo.[${TABLES.TAGS}]
        SET TAG_NAME = @TAG_NAME, ACTIVE = @ACTIVE, USER_CODE = @USER_CODE, UPDATED_DATE = GETDATE()
        WHERE TAG_CODE = @TAG_CODE
      `);

    res.json({ message: "Tag updated successfully" });
  } catch (err) {
    console.error("updateTag error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getGroups = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "", page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `SELECT GROUP_CODE, GROUP_NAME, CREATED_DATE, USER_CODE, ACTIVE FROM dbo.[${TABLES.COMPANY_GROUP}] WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) AS total FROM dbo.[${TABLES.COMPANY_GROUP}] WHERE 1=1`;

    if (search.trim()) {
      query += ` AND (GROUP_NAME LIKE '%' + @search + '%' OR GROUP_CODE LIKE '%' + @search + '%')`;
      countQuery += ` AND (GROUP_NAME LIKE '%' + @search + '%' OR GROUP_CODE LIKE '%' + @search + '%')`;
    }

    query += ` ORDER BY CREATED_DATE DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;

    const request = pool.request();
    request.input("search", sql.VarChar(100), search);
    request.input("offset", sql.Int, offset);
    request.input("limit", sql.Int, parseInt(limit));

    const [dataResult, countResult] = await Promise.all([
      request.query(query),
      pool.request().input("search", sql.VarChar(100), search).query(countQuery)
    ]);

    res.json({ data: dataResult.recordset, total: countResult.recordset[0].total });
  } catch (err) {
    console.error("getGroups error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addGroup = async (req, res) => {
  try {
    const { GROUP_NAME, ACTIVE, usercode } = req.body;
    if (!GROUP_NAME) return res.status(400).json({ error: "Group name is required" });
    if (!usercode) return res.status(400).json({ error: "User code is required" });

    const pool = await poolPromise;

    const existing = await pool.request()
      .input("GROUP_NAME", sql.NVarChar(255), GROUP_NAME)
      .query(`SELECT GROUP_CODE FROM dbo.[${TABLES.COMPANY_GROUP}] WHERE GROUP_NAME = @GROUP_NAME`);

    if (existing.recordset.length > 0) return res.status(409).json({ error: "Group name already exists" });

    let GROUP_CODE;
    let exists = true;
    while (exists) {
      GROUP_CODE = "GRP" + Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, "0");
      const chk = await pool.request()
        .input("GROUP_CODE", sql.VarChar(50), GROUP_CODE)
        .query(`SELECT 1 FROM dbo.[${TABLES.COMPANY_GROUP}] WHERE GROUP_CODE = @GROUP_CODE`);
      exists = chk.recordset.length > 0;
    }

    await pool.request()
      .input("GROUP_CODE", sql.VarChar(50), GROUP_CODE)
      .input("GROUP_NAME", sql.NVarChar(255), GROUP_NAME)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("ACTIVE", sql.Bit, ACTIVE ?? 1)
      .query(`INSERT INTO dbo.[${TABLES.COMPANY_GROUP}] (GROUP_CODE, GROUP_NAME, USER_CODE, ACTIVE, CREATED_DATE) VALUES (@GROUP_CODE, @GROUP_NAME, @USER_CODE, @ACTIVE, GETDATE())`);

    return res.status(200).json({ success: true, message: "Group created successfully", groupCode: GROUP_CODE });
  } catch (err) {
    console.error("addGroup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    const { groupCode } = req.params;
    const { GROUP_NAME, ACTIVE, usercode } = req.body;
    if (!GROUP_NAME) return res.status(400).json({ error: "Group name is required" });

    const pool = await poolPromise;
    await pool.request()
      .input("GROUP_CODE", sql.VarChar(50), groupCode)
      .input("GROUP_NAME", sql.NVarChar(255), GROUP_NAME)
      .input("ACTIVE", sql.Bit, ACTIVE)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`UPDATE dbo.[${TABLES.COMPANY_GROUP}] SET GROUP_NAME = @GROUP_NAME, ACTIVE = @ACTIVE, USER_CODE = @USER_CODE, UPDATED_DATE = GETDATE() WHERE GROUP_CODE = @GROUP_CODE`);

    res.json({ message: "Group updated successfully" });
  } catch (err) {
    console.error("updateGroup error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    const { groupCode } = req.params;
    const pool = await poolPromise;

    const memberCheck = await pool.request()
      .input("GROUP_CODE", sql.VarChar(50), groupCode)
      .query(`SELECT COUNT(*) AS cnt FROM dbo.[${TABLES.COMPANY_GROUP_MEMBER}] WHERE GROUP_CODE = @GROUP_CODE`);

    const count = memberCheck.recordset[0].cnt;
    if (count > 0) {
      return res.status(400).json({ error: `Cannot delete — this group has ${count} company member(s). Reassign or remove them first.` });
    }

    await pool.request()
      .input("GROUP_CODE", sql.VarChar(50), groupCode)
      .query(`DELETE FROM dbo.[${TABLES.COMPANY_GROUP}] WHERE GROUP_CODE = @GROUP_CODE`);

    res.json({ message: "Group deleted successfully" });
  } catch (err) {
    console.error("deleteGroup error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addEditor = async (req, res) => {
  try {
    let {
      name,
      password,
      department,
      role,
      usercode,
      data_count = 0,
      email,
      phone,
    } = req.body;

    if (!name || !password) {
      return res
        .status(400)
        .json({ error: "USERNAME and PASSWORD are required" });
    }

    const pool = await poolPromise;

    const duplicate = await pool.request()
      .input("USERNAME", sql.VarChar(100), name)
      .input("EMAIL", sql.VarChar(100), email)
      .input("PHONE", sql.VarChar(50), phone)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .query(`
        SELECT USERNAME, EMAIL, PHONE, USER_CODE
        FROM dbo.[${TABLES.USER}]
        WHERE USERNAME = @USERNAME
           OR EMAIL = @EMAIL
           OR PHONE = @PHONE
           OR USER_CODE = @USER_CODE
      `);

    if (duplicate.recordset.length > 0) {
      const row = duplicate.recordset[0];
      if (row.USER_CODE === usercode)
        return res.status(400).json({ error: "User code already exists" });
      if (row.EMAIL === email)
        return res.status(400).json({ error: "Email already exists" });

      if (row.PHONE === phone)
        return res.status(400).json({ error: "Phone already exists" });

      if (row.USERNAME === name)
        return res.status(400).json({ error: "Username already exists" });
    }

    const idResult = await pool.request().query(`
      SELECT ISNULL(MAX(ID), 0) + 1 AS NextID 
      FROM dbo.[${TABLES.USER}]
    `);

    const ID = idResult.recordset[0].NextID;
    await pool.request()
      .input("ID", sql.SmallInt, ID)
      .input("USERNAME", sql.VarChar(100), name)
      .input("PASSWORD", sql.VarChar(255), password)
      .input("DEPARTMENT", sql.VarChar(50), department)
      .input("ACCESS_LEVEL", sql.Char(1), role)
      .input("USER_CODE", sql.VarChar(50), usercode)
      .input("DATA_COUNT", sql.Decimal(18, 0), data_count)
      .input("EMAIL", sql.VarChar(100), email)
      .input("PHONE", sql.VarChar(50), phone)
      .input("ACTIVE", sql.Bit, 1)
      .query(`
        INSERT INTO dbo.[${TABLES.USER}] (
          ID, USERNAME, PASSWORD, DEPARTMENT,
          ACCESS_LEVEL, USER_CODE, DATA_COUNT, EMAIL, PHONE,
          ACTIVE, UPDATED_DATE, CREATED_DATE
        )
        VALUES (
          @ID, @USERNAME, @PASSWORD, @DEPARTMENT,
          @ACCESS_LEVEL, @USER_CODE, @DATA_COUNT, @EMAIL, @PHONE,
          @ACTIVE, GETDATE(), GETDATE()
        );
      `);

    return res.json({
      message: "User created successfully",
      ID,
    });

  } catch (err) {
    console.error("addUser error:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
  }
};

exports.editEditor = async (req, res) => {
  try {
    let {
      USERNAME,
      PASSWORD,
      DEPARTMENT,
      DEPARTMENT_HEAD,
      ACCESS_LEVEL,
      USER_CODE,
      DATA_COUNT,
      EMAIL,
      PHONE,
      ACTIVE
    } = req.body;

    if (!USERNAME || !PASSWORD) {
      return res.status(400).json({ error: "USERNAME and PASSWORD are required" });
    }

    const pool = await poolPromise;
    const idResult = await pool.request().query(`
      SELECT ISNULL(MAX(ID), 0) + 1 AS NextID FROM dbo.[${TABLES.USER}]
    `);

    const ID = idResult.recordset[0].NextID;

    const existingCode = await pool.request()
      .input("USER_CODE", sql.VarChar(50), USER_CODE)
      .query(`SELECT 1 FROM dbo.[${TABLES.USER}] WHERE USER_CODE = @USER_CODE`);

    if (existingCode.recordset.length > 0) {
      return res.status(400).json({ error: "USER_CODE already exists" });
    }

    const insert = await pool.request()
      .input("ID", sql.SmallInt, ID)
      .input("USERNAME", sql.VarChar(100), USERNAME)
      .input("PASSWORD", sql.VarChar(255), PASSWORD)
      .input("DEPARTMENT", sql.VarChar(50), DEPARTMENT)
      .input("DEPARTMENT_HEAD", sql.VarChar(50), DEPARTMENT_HEAD)
      .input("ACCESS_LEVEL", sql.Char(1), ACCESS_LEVEL)
      .input("USER_CODE", sql.VarChar(50), USER_CODE)
      .input("DATA_COUNT", sql.Decimal(18, 0), DATA_COUNT)
      .input("EMAIL", sql.VarChar(100), EMAIL)
      .input("PHONE", sql.VarChar(50), PHONE)
      .input("ACTIVE", sql.Bit, ACTIVE ?? 1)
      .query(`
        INSERT INTO dbo.[${TABLES.USER}] (
          ID, USERNAME, PASSWORD, DEPARTMENT, DEPARTMENT_HEAD,
          ACCESS_LEVEL, USER_CODE, DATA_COUNT, EMAIL, PHONE,
          ACTIVE, UPDATED_DATE, CREATED_DATE
        )
        VALUES (
          @ID, @USERNAME, @PASSWORD, @DEPARTMENT, @DEPARTMENT_HEAD,
          @ACCESS_LEVEL, @USER_CODE, @DATA_COUNT, @EMAIL, @PHONE,
          @ACTIVE, GETDATE(), GETDATE()
        );
      `);

    return res.json({
      message: "User created successfully",
      USER_CODE,
      ID
    });

  } catch (err) {
    console.error("addUser error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const pool = await poolPromise;

    const companyQuery = `
      SELECT 
        COUNT(*) AS totalCompanies,
        SUM(CASE WHEN CAST(CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE) 
            THEN 1 ELSE 0 END) AS todayCompanies
      FROM dbo.[${TABLES.COMPANY_DETAIL}]
    `;

    const personQuery = `
      SELECT 
        COUNT(*) AS totalPersons,
        SUM(CASE WHEN CAST(CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE)
            THEN 1 ELSE 0 END) AS todayPersons
      FROM dbo.[${TABLES.COMP_PERSON}]
    `;

    const exhibitionQuery = `
      SELECT 
        COUNT(*) AS totalExhibitions
      FROM dbo.[${TABLES.EVENTS}]
    `;

    const tagsQuery = `
      SELECT 
        COUNT(*) AS totalTags
      FROM dbo.[${TABLES.TAGS}]
    `;

    const [companyResult, personResult, exhibitionResult, tagResult] = await Promise.all([
      pool.request().query(companyQuery),
      pool.request().query(personQuery),
      pool.request().query(exhibitionQuery),
      pool.request().query(tagsQuery),
    ]);

    const company = companyResult.recordset[0];
    const person = personResult.recordset[0];
    const exhibition = exhibitionResult.recordset[0];
    const tag = tagResult.recordset[0];

    res.json({
      totalCompanies: company.totalCompanies || 0,
      totalPersons: person.totalPersons || 0,
      totalExhibitions: exhibition.totalExhibitions || 0,
      todayCompanies: company.todayCompanies || 0,
      todayPersons: person.todayPersons || 0,
      totalTags: tag.totalTags || 0
    });

  } catch (err) {
    console.error("getDashboardStats error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getDashboardActivity = async (req, res) => {
  try {
    const { user_code, startDate, endDate } = req.query;
    if (!user_code) return res.status(400).json({ error: "user_code is required" });

    const pool = await poolPromise;

    let companyQuery = `
      SELECT CAST(c.CREATED_DATE AS DATE) AS date, COUNT(*) AS companies
      FROM dbo.[${TABLES.COMPANY_DETAIL}] c
      INNER JOIN dbo.[${TABLES.COMP_MASTER}] m ON c.COMPANY_CODE = m.COMPANY_CODE
      WHERE 1=1
    `;
    let personQuery = `
      SELECT CAST(CREATED_DATE AS DATE) AS date, COUNT(*) AS persons
      FROM dbo.[${TABLES.COMP_PERSON}]
      WHERE 1=1
    `;

    const companyReq = pool.request();
    const personReq = pool.request();

    if (user_code !== "ALL") {
      companyReq.input("user_code", sql.VarChar(50), user_code);
      personReq.input("user_code", sql.VarChar(50), user_code);
      companyQuery += " AND m.USER_CODE = @user_code";
      personQuery += " AND USER_CODE = @user_code";
    }

    if (startDate && endDate) {
      companyReq.input("startDate", sql.Date, startDate);
      companyReq.input("endDate", sql.Date, endDate);
      personReq.input("startDate", sql.Date, startDate);
      personReq.input("endDate", sql.Date, endDate);
      companyQuery += " AND CAST(c.CREATED_DATE AS DATE) BETWEEN @startDate AND @endDate";
      personQuery += " AND CAST(CREATED_DATE AS DATE) BETWEEN @startDate AND @endDate";
    }

    companyQuery += " GROUP BY CAST(c.CREATED_DATE AS DATE) ORDER BY date";
    personQuery += " GROUP BY CAST(CREATED_DATE AS DATE) ORDER BY date";

    const [companyRes, personRes] = await Promise.all([
      companyReq.query(companyQuery),
      personReq.query(personQuery),
    ]);

    const activityMap = {};
    companyRes.recordset.forEach(row => {
      if (!row.date) return;
      const key = row.date.toISOString().split("T")[0];
      activityMap[key] = { date: key, companies: row.companies, persons: 0 };
    });
    personRes.recordset.forEach(row => {
      if (!row.date) return;
      const key = row.date.toISOString().split("T")[0];
      if (activityMap[key]) {
        activityMap[key].persons = row.persons;
      } else {
        activityMap[key] = { date: key, companies: 0, persons: row.persons };
      }
    });

    res.json(Object.values(activityMap).sort((a, b) => new Date(a.date) - new Date(b.date)));
  } catch (err) {
    console.error("getDashboardActivity error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getSalesReport = async (req, res) => {
  try {
    const {
      exhName, attendee, event,
      exhType = "person",
      industries, segments,
      dateFrom, dateTo,
      export: doExport = "false",
    } = req.query;

    const isExport = doExport === "true";
    const pool = await poolPromise;
    const request = pool.request();
    const whereClauses = ["1=1"];

    const industryList = industries ? industries.split(",").filter(Boolean) : [];
    const segmentList  = segments  ? segments.split(",").filter(Boolean)  : [];

    // Exhibition filter — IN subquery for dedup, OUTER APPLY for display columns
    const needsExhFilter = !!(exhName || attendee || event);
    let exhApplySQL = "";
    let exhSelectSQL = "";

    if (needsExhFilter) {
      const exhConds = [];
      if (exhName)  { request.input("exhName",  sql.NVarChar, `%${exhName}%`);  exhConds.push("EXH_NAME LIKE @exhName"); }
      if (attendee) { request.input("attendee", sql.NVarChar, `%${attendee}%`); exhConds.push("ATTENDEE LIKE @attendee"); }
      if (event)    { request.input("event",    sql.NVarChar, `%${event}%`);    exhConds.push("EVENT LIKE @event"); }

      const exhWhere    = exhConds.length ? "WHERE "    + exhConds.join(" AND ") : "";
      const exhAndConds = exhConds.length ? " AND "     + exhConds.join(" AND ") : "";

      if (exhType === "company") {
        whereClauses.push(`CP.COMPANY_CODE IN (SELECT COMPANY_CODE FROM dbo.[${TABLES.COMP_EXH_HISTORY}] ${exhWhere})`);
        exhApplySQL  = `OUTER APPLY (SELECT TOP 1 EXH_NAME, EXH_YEAR, EXH_LOCATION, EVENT, ATTENDEE FROM dbo.[${TABLES.COMP_EXH_HISTORY}] WHERE COMPANY_CODE = CP.COMPANY_CODE${exhAndConds}) EHD`;
        exhSelectSQL = `,\n        EHD.EXH_NAME AS EXH_NAME, EHD.EXH_YEAR AS EXH_YEAR, EHD.EXH_LOCATION AS EXH_LOCATION, EHD.EVENT AS EXH_EVENT, EHD.ATTENDEE AS EXH_ATTENDEE`;
      } else {
        whereClauses.push(`CP.PERSON_CODE IN (SELECT PERSON_CODE FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] ${exhWhere})`);
        exhApplySQL  = `OUTER APPLY (SELECT TOP 1 EXH_NAME, EXH_YEAR, EVENT, ATTENDEE FROM dbo.[${TABLES.COMP_PERSON_EXH_HISTORY}] WHERE PERSON_CODE = CP.PERSON_CODE${exhAndConds}) EHD`;
        exhSelectSQL = `,\n        EHD.EXH_NAME AS EXH_NAME, EHD.EXH_YEAR AS EXH_YEAR, EHD.EVENT AS EXH_EVENT, EHD.ATTENDEE AS EXH_ATTENDEE`;
      }
    }

    // Date filters on person updated date
    if (dateFrom) { request.input("dateFrom", sql.Date, dateFrom); whereClauses.push("CAST(CP.UPDATED_DATE AS DATE) >= @dateFrom"); }
    if (dateTo)   { request.input("dateTo",   sql.Date, dateTo);   whereClauses.push("CAST(CP.UPDATED_DATE AS DATE) <= @dateTo"); }

    if (industryList.length > 0) {
      const p = industryList.map((v, i) => { request.input(`ind_${i}`, sql.NVarChar, v); return `@ind_${i}`; });
      whereClauses.push(`EXISTS (SELECT 1 FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m2 JOIN dbo.[${TABLES.INDSEGMENT}] s2 ON m2.SEG_CODE=s2.SEG_CODE WHERE m2.COMPANY_CODE=CP.COMPANY_CODE AND s2.INDUSTRY IN (${p.join(",")}))`);
    }
    if (segmentList.length > 0) {
      const p = segmentList.map((v, i) => { request.input(`seg_${i}`, sql.NVarChar, v); return `@seg_${i}`; });
      whereClauses.push(`EXISTS (SELECT 1 FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m3 WHERE m3.COMPANY_CODE=CP.COMPANY_CODE AND m3.SEG_CODE IN (${p.join(",")}))`);
    }

    const whereSQL  = "WHERE " + whereClauses.join(" AND ");
    const topClause = isExport ? "" : "TOP 300";

    const query = `
      WITH CompSegInfo AS (
        SELECT m.COMPANY_CODE,
          STRING_AGG(s.SEGMENT,  ', ') AS SEGMENTS,
          STRING_AGG(s.INDUSTRY, ', ') AS INDUSTRIES
        FROM dbo.[${TABLES.COMP_SEGMENT_MAP}] m
        JOIN dbo.[${TABLES.INDSEGMENT}] s ON m.SEG_CODE = s.SEG_CODE
        GROUP BY m.COMPANY_CODE
      )
      SELECT ${topClause}
        CP.PERSON_CODE, CP.COMPANY_CODE,
        LTRIM(RTRIM(ISNULL(CP.PREFIX,'') + ' ' + ISNULL(CP.FNAME,'') + ' ' + ISNULL(CP.LNAME,''))) AS PERSON_NAME,
        CASE WHEN ISJSON(CP.DESIG)=1 THEN JSON_VALUE(CP.DESIG,'$[0].value') ELSE CP.DESIG END AS DESIGNATION,
        CASE WHEN ISJSON(CP.DESIG)=1 THEN JSON_VALUE(CP.DESIG,'$[0].rank')  ELSE NULL      END AS RANK_,
        CASE WHEN ISJSON(CP.DEPT)=1  THEN JSON_VALUE(CP.DEPT,'$[0]')        ELSE CP.DEPT   END AS DEPT_1,
        CASE WHEN ISJSON(CP.DEPT)=1  THEN JSON_VALUE(CP.DEPT,'$[1]')        ELSE NULL      END AS DEPT_2,
        CD.COMPANY_NAME, CD.DIVISION,
        CASE WHEN ISJSON(CD.ADDRESS)=1 THEN JSON_VALUE(CD.ADDRESS,'$[0].type')  ELSE NULL END AS ADDRESS_TYPE,
        CASE WHEN ISJSON(CD.ADDRESS)=1 THEN JSON_VALUE(CD.ADDRESS,'$[0].line1') ELSE NULL END AS COMP_ADD_1,
        CASE WHEN ISJSON(CD.ADDRESS)=1 THEN JSON_VALUE(CD.ADDRESS,'$[0].line2') ELSE NULL END AS COMP_ADD_2,
        CASE WHEN ISJSON(CD.ADDRESS)=1 THEN JSON_VALUE(CD.ADDRESS,'$[0].line3') ELSE NULL END AS COMP_ADD_3,
        CASE WHEN ISJSON(CD.ADDRESS)=1 THEN JSON_VALUE(CD.ADDRESS,'$[0].line4') ELSE NULL END AS COMP_ADD_4,
        CD.CITY, CD.PINCODE, CD.STATE, CD.COUNTRY, CD.WEBSITE,
        CASE WHEN ISJSON(CD.EMAIL)=1 THEN JSON_VALUE(CD.EMAIL,'$[0]') ELSE NULL END AS COMP_EMAIL1,
        CASE WHEN ISJSON(CD.EMAIL)=1 THEN JSON_VALUE(CD.EMAIL,'$[1]') ELSE NULL END AS COMP_EMAIL2,
        CASE WHEN ISJSON(CD.EMAIL)=1 THEN JSON_VALUE(CD.EMAIL,'$[2]') ELSE NULL END AS COMP_EMAIL3,
        CASE WHEN ISJSON(CD.EMAIL)=1 THEN JSON_VALUE(CD.EMAIL,'$[3]') ELSE NULL END AS COMP_EMAIL4,
        CD.ISDCODE AS COMP_ISD, CD.STDCODE AS COMP_STD,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[0].type')   ELSE NULL END AS COMP_PHONE_TYPE1,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[0].number') ELSE NULL END AS COMP_PHONE1,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[1].type')   ELSE NULL END AS COMP_PHONE_TYPE2,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[1].number') ELSE NULL END AS COMP_PHONE2,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[2].type')   ELSE NULL END AS COMP_PHONE_TYPE3,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[2].number') ELSE NULL END AS COMP_PHONE3,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[3].type')   ELSE NULL END AS COMP_PHONE_TYPE4,
        CASE WHEN ISJSON(CD.PHONES)=1 THEN JSON_VALUE(CD.PHONES,'$[3].number') ELSE NULL END AS COMP_PHONE4,
        CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[0]') ELSE NULL END AS PERSON_EMAIL1,
        CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[1]') ELSE NULL END AS PERSON_EMAIL2,
        CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[2]') ELSE NULL END AS PERSON_EMAIL3,
        CASE WHEN ISJSON(CP.PERSON_EMAIL)=1 THEN JSON_VALUE(CP.PERSON_EMAIL,'$[3]') ELSE NULL END AS PERSON_EMAIL4,
        CASE WHEN ISJSON(CP.MOBILE)=1 THEN JSON_VALUE(CP.MOBILE,'$[0].number') ELSE NULL END AS PERSON_MOBILE1,
        CASE WHEN ISJSON(CP.MOBILE)=1 THEN JSON_VALUE(CP.MOBILE,'$[1].number') ELSE NULL END AS PERSON_MOBILE2,
        CASE WHEN ISJSON(CP.MOBILE)=1 THEN JSON_VALUE(CP.MOBILE,'$[2].number') ELSE NULL END AS PERSON_MOBILE3,
        CASE WHEN ISJSON(CP.MOBILE)=1 THEN JSON_VALUE(CP.MOBILE,'$[3].number') ELSE NULL END AS PERSON_MOBILE4,
        CP.OLD_MOBILE AS PERSON_OLD_MOBILE,
        CP.REMARKS, CP.CONTACTDATE, CP.PERSON_CUPD_REMARK,
        CP.USER_CODE,
        CP.UPDATED_DATE AS PERSON_UPDATED_DATE,
        CP.CREATED_DATE AS PERSON_CREATED_DATE,
        CM.REMARKS AS MASTER_REMARKS,
        CSI.INDUSTRIES, CSI.SEGMENTS
        ${exhSelectSQL}
      FROM dbo.[${TABLES.COMP_PERSON}] CP
      LEFT JOIN dbo.[${TABLES.COMP_MASTER}]    CM  ON CM.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN dbo.[${TABLES.COMPANY_DETAIL}] CD  ON CD.COMPANY_CODE  = CP.COMPANY_CODE
      LEFT JOIN CompSegInfo                    CSI ON CSI.COMPANY_CODE = CP.COMPANY_CODE
      ${exhApplySQL}
      ${whereSQL}
      ORDER BY CP.COMPANY_CODE, CP.PERSON_CODE
    `;

    const result = await request.query(query);
    const rows = result.recordset;

    if (!isExport) {
      return res.json({ data: rows, total: rows.length, capped: rows.length === 300 });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Custom Report");
    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      const headerRow = sheet.addRow(headers);
      headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
      });
      rows.forEach(row => sheet.addRow(headers.map(h => row[h])));
      sheet.columns.forEach(col => { col.width = 20; });
    }

    res.setHeader("Content-Disposition", `attachment; filename=custom-report-${Date.now()}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("getSalesReport error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.getActivityReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to dates are required" });

    const pool = await poolPromise;
    const query = `
      WITH
      CompAdded AS (
        SELECT USER_CODE, COUNT(DISTINCT COMPANY_CODE) AS CNT
        FROM dbo.[${TABLES.COMPANY_UPDATE_HISTORY}]
        WHERE STATUS = 'A'
          AND CAST(UPDATED_DATE AS DATE) BETWEEN @from AND @to
        GROUP BY USER_CODE
      ),
      CompUpdated AS (
        SELECT USER_CODE, COUNT(DISTINCT COMPANY_CODE) AS CNT
        FROM dbo.[${TABLES.COMPANY_UPDATE_HISTORY}]
        WHERE STATUS = 'U'
          AND CAST(UPDATED_DATE AS DATE) BETWEEN @from AND @to
        GROUP BY USER_CODE
      ),
      PersonAdded AS (
        SELECT USER_CODE, COUNT(DISTINCT PERSON_CODE) AS CNT
        FROM dbo.[${TABLES.COMP_PERSON_UPDATE_HISTORY}]
        WHERE STATUS = 'A'
          AND CAST(UPDATED_DATE AS DATE) BETWEEN @from AND @to
        GROUP BY USER_CODE
      ),
      PersonUpdated AS (
        SELECT USER_CODE, COUNT(DISTINCT PERSON_CODE) AS CNT
        FROM dbo.[${TABLES.COMP_PERSON_UPDATE_HISTORY}]
        WHERE STATUS = 'U'
          AND CAST(UPDATED_DATE AS DATE) BETWEEN @from AND @to
        GROUP BY USER_CODE
      ),
      AllUsers AS (
        SELECT USER_CODE FROM CompAdded
        UNION SELECT USER_CODE FROM CompUpdated
        UNION SELECT USER_CODE FROM PersonAdded
        UNION SELECT USER_CODE FROM PersonUpdated
      )
      SELECT
        U.USERNAME,
        A.USER_CODE,
        ISNULL(CA.CNT, 0) AS COMP_ADDED,
        ISNULL(CU.CNT, 0) AS COMP_UPDATED,
        ISNULL(PA.CNT, 0) AS PERSON_ADDED,
        ISNULL(PU.CNT, 0) AS PERSON_UPDATED,
        ISNULL(CA.CNT, 0) + ISNULL(CU.CNT, 0) + ISNULL(PA.CNT, 0) + ISNULL(PU.CNT, 0) AS TOTAL
      FROM AllUsers A
      JOIN dbo.[${TABLES.USER}] U ON U.USER_CODE = A.USER_CODE
      LEFT JOIN CompAdded CA ON CA.USER_CODE = A.USER_CODE
      LEFT JOIN CompUpdated CU ON CU.USER_CODE = A.USER_CODE
      LEFT JOIN PersonAdded PA ON PA.USER_CODE = A.USER_CODE
      LEFT JOIN PersonUpdated PU ON PU.USER_CODE = A.USER_CODE
      ORDER BY TOTAL DESC
    `;

    const result = await pool.request()
      .input("from", sql.Date, from)
      .input("to", sql.Date, to)
      .query(query);

    res.json(result.recordset);
  } catch (err) {
    console.error("getActivityReport error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

exports.exportData = async (req, res) => {
  try {
    const {
      tables,
      columns,
      joins,
      where = [],
      segments,
      reason,
      exportType,
      userCode,
      username,
      ipAddress
    } = req.body;

    if (!tables?.length || !Object.keys(columns).length) {
      return res.status(400).json({ message: "No tables or columns selected" });
    }

    const selectCols = [];
    tables.forEach((t) => {
      (columns[t] || []).forEach((c) => {
        selectCols.push(`${t}.${c} AS ${t}_${c}`);
      });
    });

    if (!selectCols.length) {
      return res.status(400).json({ message: "No columns selected" });
    }

    let sqlQuery = `SELECT DISTINCT ${selectCols.join(", ")} FROM ${tables[0]}`;

    const joinedTables = new Set();
    const joinFilters = {};  
    const whereClauses = [];

    const LEFT_JOIN_TABLES = [
      "COMP_EXH_HISTORY",
      "COMP_PERSON_EXH_HISTORY"
    ];

    where.forEach((w) => {
      if (!w.table || !w.column || w.value === undefined || w.value === null) return;

      const condition = `${w.table}.${w.column} ${w.operator} '${w.value}'`;

      if (LEFT_JOIN_TABLES.includes(w.table)) {
        if (!joinFilters[w.table]) joinFilters[w.table] = [];
        joinFilters[w.table].push(condition);
      } else {
        whereClauses.push(condition);
      }
    });

    joins.forEach((j) => {
      if (tables.includes(j.from) && tables.includes(j.to) && !joinedTables.has(j.to)) {
        let joinClause = `${j.type} JOIN ${j.to}`;
        if (j.to === "COMP_SEGMENT_MAP") joinClause += " AS CSM";

        joinClause += ` ON ${j.on}`;

        if (joinFilters[j.to]?.length) {
          joinClause += " AND " + joinFilters[j.to].join(" AND ");
        }

        sqlQuery += ` ${joinClause}`;
        joinedTables.add(j.to);
      }
    });

    if (segments?.length) {
      if (!joinedTables.has("COMP_SEGMENT_MAP")) {
        sqlQuery += ` LEFT JOIN COMP_SEGMENT_MAP AS CSM 
                      ON CSM.COMPANY_CODE = ${tables[0]}.COMPANY_CODE`;
      }

      whereClauses.push(
        `CSM.SEG_CODE IN (${segments.map((s) => `'${s}'`).join(", ")})`
      );
    }

    if (whereClauses.length) {
      sqlQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    console.log("======== sqlQuery",sqlQuery);

    const pool = await poolPromise;
    const result = await pool.request().query(sqlQuery);
    const rows = result.recordset;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Export");

    if (rows.length > 0) {
      const headers = selectCols.map(c => {
        const m = c.match(/ AS (.+)$/i);
        return m ? m[1] : c;
      });

      sheet.addRow(headers);

      rows.forEach(row => {
        sheet.addRow(headers.map(h => row[h]));
      });
    }

    await pool.request()
      .input("USER_CODE", sql.VarChar, userCode || "EIAD")
      .input("USERNAME", sql.VarChar, username || "eiadmin")
      .input("IP_ADDRESS", sql.VarChar, ipAddress || "")
      .input("EXPORT_REASON", sql.VarChar, reason)
      .input("EXPORT_TYPE", sql.VarChar, exportType)
      .query(`
        INSERT INTO DATA_EXPORT_LOG
        (USER_CODE, USERNAME, IP_ADDRESS, EXPORT_REASON, EXPORT_TYPE, CREATED_AT)
        VALUES (@USER_CODE, @USERNAME, @IP_ADDRESS, @EXPORT_REASON, @EXPORT_TYPE, GETDATE())
      `);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=export-${Date.now()}.xlsx`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ message: "Export failed", error: err.message });
  }
};















