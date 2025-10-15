const { Country, State, City } = require("country-state-city");
const { poolPromise } = require("../db");

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

async function getCountsByUser(table, dateColumn, user_code) {
  const pool = await poolPromise;
  const today = new Date().toISOString().slice(0, 10);

  const result = await pool.request()
    .input("user_code", sql.VarChar(10), user_code)
    .query(`
      SELECT 
        COUNT(*) AS Total,
        SUM(CASE WHEN CAST(${dateColumn} AS DATE) = '${today}' THEN 1 ELSE 0 END) AS Today
      FROM ${table} 
      WHERE USER_CODE = @user_code
    `);
  return result.recordset[0];
}

exports.getStats = async (req, res) => {
  try {
    const { user_code } = req.query;
    if (!user_code) {
      return res.status(400).json({ error: "user_code is required" });
    }

    const companyCounts = await getCountsByUser("DEVP_COMPANY_DETAIL", "CREATED_DATE", user_code);
    const personCounts = await getCountsByUser("DEVP_COMP_PERSON", "CREATED_DATE", user_code);

    res.json({
      CompaniesToday: companyCounts.Today,
      CompaniesMonth: companyCounts.Total,
      PersonsToday: personCounts.Today,
      PersonsMonth: personCounts.Total
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
      dateFilter = `AND CAST(CREATED_DATE AS DATE) BETWEEN '${startDate}' AND '${endDate}'`;
    }

    const companyActivity = await pool.request()
      .input("user_code", sql.VarChar(10), user_code)
      .query(`
        SELECT CAST(CREATED_DATE AS DATE) AS date, COUNT(*) AS companies
        FROM DEVP_COMPANY_DETAIL
        WHERE USER_CODE = @user_code ${dateFilter}
        GROUP BY CAST(CREATED_DATE AS DATE)
        ORDER BY date
      `);

    const personActivity = await pool.request()
      .input("user_code", sql.VarChar(10), user_code)
      .query(`
        SELECT CAST(CREATED_DATE AS DATE) AS date, COUNT(*) AS persons
        FROM DEVP_COMP_PERSON
        WHERE USER_CODE = @user_code ${dateFilter}
        GROUP BY CAST(CREATED_DATE AS DATE)
        ORDER BY date
      `);

    const activityMap = {};
    companyActivity.recordset.forEach(c => {
      activityMap[c.date] = { date: c.date, companies: c.companies, persons: 0 };
    });
    personActivity.recordset.forEach(p => {
      if (activityMap[p.date]) {
        activityMap[p.date].persons = p.persons;
      } else {
        activityMap[p.date] = { date: p.date, companies: 0, persons: p.persons };
      }
    });

    const mergedActivity = Object.values(activityMap).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json(mergedActivity);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
};

module.exports = router;






