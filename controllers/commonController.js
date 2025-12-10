const { Country, State, City } = require("country-state-city");
const { poolPromise, sql } = require("../db");
const { TABLES } = require('../helper');

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
    const result = await pool
      .request()
      .query(`
        SELECT CATEGORY_TYPE, LABEL, VALUE 
        FROM dbo.[${TABLES.CATEGORY}] 
        WHERE ACTIVE = 1
      `);

    const rows = result.recordset;

    const grouped = rows.reduce((acc, row) => {
      if (!acc[row.CATEGORY_TYPE]) {
        acc[row.CATEGORY_TYPE] = [];
      }
      acc[row.CATEGORY_TYPE].push({
        label: row.LABEL,
        value: row.VALUE,
      });
      return acc;
    }, {});

    res.json(grouped);
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
      pool.request().input("user_code", sql.VarChar(10), user_code).query(companyQuery),
      pool.request().input("user_code", sql.VarChar(10), user_code).query(personQuery),
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
      pool.request().input("user_code", sql.VarChar(10), user_code).query(companyQuery),
      pool.request().input("user_code", sql.VarChar(10), user_code).query(personQuery),
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
      query += ` WHERE EVENT_NAME LIKE '%' + @search + '%'`;
      countQuery += ` WHERE EVENT_NAME LIKE '%' + @search + '%'`;
    }

    query += `
      ORDER BY EVENT_NAME
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
    
    let { ATTENDEE = [] } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    const attendeeJson = JSON.stringify(ATTENDEE);

    const query = `
      UPDATE dbo.[${TABLES.EVENTS}]
      SET ATTENDEE = @ATTENDEE,
          UPDATED_DATE = GETDATE()
      WHERE ID = @ID
    `;

    const request = pool.request();
    request.input("ID", sql.Int, id);
    request.input("ATTENDEE", sql.NVarChar(sql.MAX), attendeeJson);

    await request.query(query);

    res.status(200).json({
      message: "Event attendees updated successfully",
      attendees: ATTENDEE
    });

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
      SELECT EVENT_NAME, EVENT_YEAR, EVENT_CODE, EVENT_LOCATION, CREATED_DATE, USER_CODE
      FROM dbo.[${TABLES.EVENTS}]
    `;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM dbo.[${TABLES.EVENTS}]
    `;

    const request = pool.request();
    const countRequest = pool.request();

    if (search.trim() !== "") {
      query += ` WHERE EVENT_NAME LIKE '%' + @search + '%'`;
      countQuery += ` WHERE EVENT_NAME LIKE '%' + @search + '%'`;

      request.input("search", sql.VarChar(100), search);
      countRequest.input("search", sql.VarChar(100), search);
    }

    query += ` ORDER BY EVENT_NAME`;

    const [dataResult, countResult] = await Promise.all([
      request.query(query),
      countRequest.query(countQuery)
    ]);

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

    const EVENT_CODE = generateEventCode();

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
      query += ` AND TAG_NAME LIKE '%' + @search + '%'`;
      countQuery += ` AND TAG_NAME LIKE '%' + @search + '%'`;
    }

    query += `
      ORDER BY TAG_NAME
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
    const { TAG_NAME, usercode } = req.body;

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
      TAG_CODE = "HE" + Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .toUpperCase()
        .padStart(6, "0");

      const chk = await pool.request()
        .input("TAG_CODE", sql.VarChar(10), TAG_CODE)
        .query(`SELECT 1 FROM dbo.${TABLES.TAGS} WHERE TAG_CODE = @TAG_CODE`);

      exists = chk.recordset.length > 0;
    }

    await pool.request()
      .input("TAG_NAME", sql.VarChar(100), TAG_NAME)
      .input("USER_CODE", sql.VarChar(10), usercode)
      .input("TAG_CODE", sql.VarChar(10), TAG_CODE)
      .query(`
        INSERT INTO dbo.${TABLES.TAGS} (TAG_NAME, USER_CODE, ACTIVE, TAG_CODE)
        VALUES (@TAG_NAME, @USER_CODE, 1, @TAG_CODE)
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
      .input("USER_CODE", sql.VarChar(10), usercode)
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
      .input("USER_CODE", sql.VarChar(10), usercode)
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
      .input("USER_CODE", sql.VarChar(10), USER_CODE)
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
      .input("USER_CODE", sql.VarChar(10), USER_CODE)
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

    // User filter
    if (user_code !== "ALL") {
      companyReq.input("user_code", sql.VarChar(50), user_code);
      personReq.input("user_code", sql.VarChar(10), user_code);
      companyQuery += " AND m.USER_CODE = @user_code";
      personQuery += " AND USER_CODE = @user_code";
    }

    // Date filter
    if (startDate && endDate) {
      companyReq.input("startDate", sql.Date, startDate);
      companyReq.input("endDate", sql.Date, endDate);
      personReq.input("startDate", sql.Date, startDate);
      personReq.input("endDate", sql.Date, endDate);
      companyQuery += " AND CAST(c.CREATED_DATE AS DATE) BETWEEN @startDate AND @endDate";
      personQuery += " AND CAST(CREATED_DATE AS DATE) BETWEEN @startDate AND @endDate";
    }

    // Grouping & ordering
    companyQuery += " GROUP BY CAST(c.CREATED_DATE AS DATE) ORDER BY date";
    personQuery += " GROUP BY CAST(CREATED_DATE AS DATE) ORDER BY date";

    // Execute
    const [companyRes, personRes] = await Promise.all([
      companyReq.query(companyQuery),
      personReq.query(personQuery),
    ]);

    // Merge results
    const activityMap = {};
    companyRes.recordset.forEach(row => {
      const key = row.date.toISOString().split("T")[0];
      activityMap[key] = { date: key, companies: row.companies, persons: 0 };
    });
    personRes.recordset.forEach(row => {
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













