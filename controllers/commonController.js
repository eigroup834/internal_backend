const { Country, State, City } = require("country-state-city");
const { poolPromise, sql } = require("../db");

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
        FROM dbo.DEVP_USER
        ${whereSQL}
      )
      SELECT *
      FROM UserData
      WHERE RowNum BETWEEN ${offset + 1} AND ${offset + limitNum};
      SELECT COUNT(*) AS total
      FROM dbo.DEVP_USER
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
        FROM DEVP_CATEGORY 
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
      FROM DEVP_COMPANY_DETAIL c
      INNER JOIN DEVP_MASTER m ON c.COMPANY_CODE = m.COMPANY_CODE
      WHERE m.USER_CODE = @user_code
    `;

    const personQuery = `
      SELECT 
        COUNT(*) AS Total,
        SUM(CASE WHEN CAST(CREATED_DATE AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today
      FROM DEVP_COMP_PERSON
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
      FROM DEVP_COMPANY_DETAIL c
      INNER JOIN DEVP_MASTER m ON c.COMPANY_CODE = m.COMPANY_CODE
      WHERE m.USER_CODE = @user_code ${dateFilter}
      GROUP BY CAST(c.CREATED_DATE AS DATE)
      ORDER BY date
    `;

    const personQuery = `
      SELECT 
        CAST(CREATED_DATE AS DATE) AS date, 
        COUNT(*) AS persons
      FROM DEVP_COMP_PERSON
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
      SELECT EVENT_NAME, EVENT_YEAR, EVENT_CODE, EVENT_LOCATION, CREATED_DATE, USER_CODE
      FROM DEVP_EVENTS
    `;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM DEVP_EVENTS
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

    res.json({
      data: dataResult.recordset,
      total: countResult.recordset[0].total,
    });
  } catch (err) {
    console.error("getEvents error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.addEvent = async (req, res) => {
  try {
    const pool = await poolPromise;

    const {
      EVENT_NAME,
      EVENT_YEAR,
      EVENT_LOCATION,
      USER_CODE
    } = req.body;

    if (!EVENT_NAME  || !EVENT_YEAR || !EVENT_LOCATION || !USER_CODE) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const EVENT_CODE = generateEventCode();

    const query = `
      INSERT INTO DEVP_EVENTS
        (EVENT_NAME, EVENT_CODE, EVENT_YEAR, EVENT_LOCATION,
        CREATED_DATE, UPDATED_DATE, USER_CODE)
      VALUES
        (@EVENT_NAME, @EVENT_CODE, @EVENT_YEAR, @EVENT_LOCATION,
         GETDATE(), GETDATE(), @USER_CODE);

      SELECT SCOPE_IDENTITY() AS newId;
    `;

    const request = pool.request();
    request.input("EVENT_NAME", sql.VarChar(255), EVENT_NAME);
    request.input("EVENT_CODE", sql.VarChar(100), EVENT_CODE);
    request.input("EVENT_YEAR", sql.Int, EVENT_YEAR);
    request.input("EVENT_LOCATION", sql.VarChar(255), EVENT_LOCATION);
    request.input("USER_CODE", sql.VarChar(100), USER_CODE);

    const result = await request.query(query);

    res.status(201).json({
      message: "Event added successfully",
      eventId: result.recordset[0].newId,
    });

  } catch (err) {
    console.error("addEvent error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getTags = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { search = "", page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    let query = `
      SELECT TAG_CODE, TAG_NAME, CREATED_DATE, USER_CODE, ACTIVE
      FROM DEVP_TAGS
      WHERE ACTIVE = 1
    `;

    if (search.trim() !== "") {
      query += ` AND TAG_NAME LIKE '%' + @search + '%'`;
    }

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM DEVP_TAGS
      WHERE ACTIVE = 1
    `;
    if (search.trim() !== "") {
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
      pool.request().input("search", sql.VarChar(100), search).query(countQuery),
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
    let { tags, usercode, TAG_NAME } = req.body;

    if (!tags) {
      if (TAG_NAME) tags = [TAG_NAME];
      else return res.status(400).json({ error: "Tags array is required" });
    }

    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: "Tags array is required" });
    }

    if (!usercode) {
      return res.status(400).json({ error: "User code is required" });
    }

    const pool = await poolPromise;
    const insertedTags = [];

    for (const tagName of tags) {
      const check = await pool.request()
        .input("TAG_NAME", sql.VarChar(100), tagName)
        .query("SELECT TAG_CODE FROM DEVP_TAGS WHERE TAG_NAME = @TAG_NAME AND ACTIVE = 1");

      if (check.recordset.length > 0) {
        insertedTags.push({ TAG_CODE: check.recordset[0].TAG_CODE, TAG_NAME: tagName });
        continue;
      }

      let TAG_CODE;
      let exists = true;
      while (exists) {
        TAG_CODE = "HE" + Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, "0");
        const checkCode = await pool.request()
          .input("TAG_CODE", sql.VarChar(10), TAG_CODE)
          .query("SELECT 1 FROM DEVP_TAGS WHERE TAG_CODE = @TAG_CODE");
        exists = checkCode.recordset.length > 0;
      }

      const insertResult = await pool.request()
        .input("TAG_NAME", sql.VarChar(100), tagName)
        .input("USER_CODE", sql.VarChar(10), usercode)
        .input("TAG_CODE", sql.VarChar(10), TAG_CODE)
        .query(`
          INSERT INTO DEVP_TAGS (TAG_NAME, USER_CODE, ACTIVE, TAG_CODE)
          OUTPUT INSERTED.TAG_CODE
          VALUES (@TAG_NAME, @USER_CODE, 1, @TAG_CODE)
        `);

      insertedTags.push({ TAG_CODE: insertResult.recordset[0].TAG_CODE, TAG_NAME: tagName });
    }

    res.json(insertedTags);
  } catch (err) {
    console.error("addTags error:", err);
    res.status(500).json({ error: "Server error" });
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
        UPDATE DEVP_TAGS
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
      return res.status(400).json({ error: "USERNAME and PASSWORD are required" });
    }

    const pool = await poolPromise;
    const idResult = await pool.request().query(`
      SELECT ISNULL(MAX(ID), 0) + 1 AS NextID FROM DEVP_USER
    `);

    const ID = idResult.recordset[0].NextID;

   const existingCode = await pool.request()
        .input("USER_CODE", sql.VarChar(10), usercode)
        .query("SELECT 1 FROM DEVP_USER WHERE USER_CODE = @USER_CODE");

    if (existingCode.recordset.length > 0) {
        return res.status(400).json({ error: "User already exists" });
    }
    
    const insert = await pool.request()
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
        INSERT INTO DEVP_USER (
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
      ID
    });

  } catch (err) {
    console.error("addUser error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
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
      SELECT ISNULL(MAX(ID), 0) + 1 AS NextID FROM DEVP_USER
    `);

    const ID = idResult.recordset[0].NextID;

   const existingCode = await pool.request()
        .input("USER_CODE", sql.VarChar(10), USER_CODE)
        .query("SELECT 1 FROM DEVP_USER WHERE USER_CODE = @USER_CODE");

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
        INSERT INTO DEVP_USER (
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












