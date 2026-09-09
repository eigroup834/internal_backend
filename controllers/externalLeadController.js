const { poolPromise, sql } = require('../db');
const { TABLES } = require('../helper');

const T = `dbo.[${TABLES.VISITOR_EXTERNAL_LEAD}]`;
const USER = `dbo.[${TABLES.USER}]`;
const LEAD_LOG = `dbo.[${TABLES.VISITOR_EXTERNAL_LEAD_LOG}]`;

const SOURCES = ['POST_SHOW_SALES', 'VISITOR_REGISTRATION'];
const CATEGORIES = ['VISITOR', 'DELEGATE', 'SPEAKER', 'BUYER', 'OTHER'];

const LEAD_LOG_JOIN = `
  OUTER APPLY (
    SELECT TOP 1 ll.STATUS, ll.REMARKS, ll.CREATED_DATE
    FROM ${LEAD_LOG} ll
    WHERE ll.LEAD_ID = l.LEAD_ID
    ORDER BY ll.CREATED_DATE DESC
  ) LatestLog
`;

const SORT_EXPR = {
  contact:     'l.NAME',
  designation: 'l.DESIGNATION',
  department:  'l.DEPARTMENT',
  industry:    'l.INDUSTRY',
  mobile:      'l.MOBILE',
  email:       'l.EMAIL',
  source:      'l.SOURCE_NAME',
  status:      'LatestLog.STATUS',
  updated:     'LatestLog.CREATED_DATE',
};

const HEAD_LEVELS = [2, 5];

function scopeToMember(req, request, filters) {
  const level = Number(req.user?.access_level);
  const userCode = req.user?.user_code;
  const isHead = HEAD_LEVELS.includes(level);

  if (!isHead) {
    request.input('scopeUser', sql.VarChar(100), userCode);
    filters.push('l.ASSIGNED_TO_USER_CODE = @scopeUser');
    return;
  }
  if (req.query.member) {
    request.input('scopeUser', sql.VarChar(100), String(req.query.member));
    filters.push('l.ASSIGNED_TO_USER_CODE = @scopeUser');
  }
}

exports.list = async (req, res) => {
  try {
    const { source = '', category = '', designation = '', assigned = '', status = '', worked = '', search = '', sortBy = '', sortDir = '', page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const offset = (pageNum - 1) * limitNum;

    const sortExpr = SORT_EXPR[sortBy];
    const sortDirSQL = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBySQL = sortExpr
      ? `${sortExpr} ${sortDirSQL}, l.LEAD_ID DESC`
      : 'l.REGISTERED_DATE DESC, l.LEAD_ID DESC';

    const pool = await poolPromise;
    const request = pool.request();

    const baseFilters = ['l.PUSHED_BATCH_CODE IS NULL'];
    scopeToMember(req, request, baseFilters);
    if (search) {
      request.input('search', sql.NVarChar, `%${search}%`);
      baseFilters.push('(l.NAME LIKE @search OR l.COMPANY LIKE @search OR l.EMAIL LIKE @search OR l.MOBILE LIKE @search)');
    }
    if (designation) {
      request.input('designation', sql.NVarChar(150), designation);
      baseFilters.push("LTRIM(RTRIM(ISNULL(l.DESIGNATION, ''))) = @designation");
    }

    let sourceFilter = null;
    if (source && SOURCES.includes(source)) {
      request.input('source', sql.VarChar(40), source);
      sourceFilter = 'l.SOURCE_NAME = @source';
    }
    let categoryFilter = null;
    if (category && CATEGORIES.includes(category)) {
      request.input('category', sql.VarChar(20), category);
      categoryFilter = 'l.CATEGORY = @category';
    }
    let assignedFilter = null;
    if (assigned === 'yes') assignedFilter = 'l.ASSIGNED_TO_USER_CODE IS NOT NULL';
    else if (assigned === 'no') assignedFilter = 'l.ASSIGNED_TO_USER_CODE IS NULL';
    let statusFilter = null;
    if (status === 'NONE') statusFilter = 'LatestLog.STATUS IS NULL';
    else if (status) {
      request.input('status', sql.VarChar(30), status);
      statusFilter = 'LatestLog.STATUS = @status';
    }
    let workedFilter = null;
    if (worked === 'yes') workedFilter = 'LatestLog.STATUS IS NOT NULL';
    else if (worked === 'no') workedFilter = 'LatestLog.STATUS IS NULL';

    const listWhere = `WHERE ${[...baseFilters, sourceFilter, categoryFilter, assignedFilter, statusFilter, workedFilter].filter(Boolean).join(' AND ')}`;
    const bySourceWhere = `WHERE ${[...baseFilters, categoryFilter, assignedFilter, statusFilter, workedFilter].filter(Boolean).join(' AND ')}`;
    const byCategoryWhere = `WHERE ${[...baseFilters, sourceFilter, assignedFilter, statusFilter, workedFilter].filter(Boolean).join(' AND ')}`;
    const byAssignedWhere = `WHERE ${[...baseFilters, sourceFilter, categoryFilter, statusFilter, workedFilter].filter(Boolean).join(' AND ')}`;
    const byStatusWhere = `WHERE ${[...baseFilters, sourceFilter, categoryFilter, assignedFilter, workedFilter].filter(Boolean).join(' AND ')}`;
    const byWorkedWhere = `WHERE ${[...baseFilters, sourceFilter, categoryFilter, assignedFilter, statusFilter].filter(Boolean).join(' AND ')}`;

    request.input('offset', sql.Int, offset);
    request.input('limitNum', sql.Int, limitNum);

    const q = `
      SELECT
        l.LEAD_ID, l.SOURCE_NAME, l.CATEGORY, l.NAME, l.DESIGNATION, l.DEPARTMENT, l.COMPANY,
        l.EMAIL, l.MOBILE, l.INDUSTRY, l.EVENT_NAME, l.REGISTERED_DATE,
        l.ASSIGNED_TO_USER_CODE, u.USERNAME AS ASSIGNED_TO_NAME,
        LatestLog.STATUS AS CURRENT_STATUS,
        LatestLog.REMARKS AS LAST_REMARK,
        LatestLog.CREATED_DATE AS LAST_ACTIVITY_DATE
      FROM ${T} l
      LEFT JOIN ${USER} u ON u.USER_CODE = l.ASSIGNED_TO_USER_CODE
      ${LEAD_LOG_JOIN}
      ${listWhere}
      ORDER BY ${orderBySQL}
      OFFSET @offset ROWS FETCH NEXT @limitNum ROWS ONLY;

      SELECT COUNT(*) AS total FROM ${T} l ${LEAD_LOG_JOIN} ${listWhere};

      SELECT l.SOURCE_NAME, COUNT(*) AS n FROM ${T} l ${LEAD_LOG_JOIN} ${bySourceWhere} GROUP BY l.SOURCE_NAME;

      SELECT l.CATEGORY, COUNT(*) AS n FROM ${T} l ${LEAD_LOG_JOIN} ${byCategoryWhere} GROUP BY l.CATEGORY;

      SELECT CASE WHEN l.ASSIGNED_TO_USER_CODE IS NULL THEN 'no' ELSE 'yes' END AS bucket, COUNT(*) AS n
      FROM ${T} l ${LEAD_LOG_JOIN} ${byAssignedWhere}
      GROUP BY CASE WHEN l.ASSIGNED_TO_USER_CODE IS NULL THEN 'no' ELSE 'yes' END;

      SELECT ISNULL(LatestLog.STATUS, 'NONE') AS bucket, COUNT(*) AS n
      FROM ${T} l ${LEAD_LOG_JOIN} ${byStatusWhere}
      GROUP BY ISNULL(LatestLog.STATUS, 'NONE');

      SELECT CASE WHEN LatestLog.STATUS IS NULL THEN 'no' ELSE 'yes' END AS bucket, COUNT(*) AS n
      FROM ${T} l ${LEAD_LOG_JOIN} ${byWorkedWhere}
      GROUP BY CASE WHEN LatestLog.STATUS IS NULL THEN 'no' ELSE 'yes' END;
    `;

    const result = await request.query(q);
    const [rows, totalSet, bySourceSet, byCategorySet, byAssignedSet, byStatusSet, byWorkedSet] = result.recordsets;

    const bySource = {};
    bySourceSet.forEach((r) => { bySource[r.SOURCE_NAME] = r.n; });
    const byCategory = {};
    byCategorySet.forEach((r) => { byCategory[r.CATEGORY] = r.n; });
    const byAssigned = { yes: 0, no: 0 };
    byAssignedSet.forEach((r) => { byAssigned[r.bucket] = r.n; });
    const byStatus = {};
    byStatusSet.forEach((r) => { byStatus[r.bucket] = r.n; });
    const byWorked = { yes: 0, no: 0 };
    byWorkedSet.forEach((r) => { byWorked[r.bucket] = r.n; });

    res.json({
      data: rows,
      total: totalSet[0].total,
      page: pageNum,
      counts: { bySource, byCategory, byAssigned, byStatus, byWorked, unassigned: byAssigned.no },
    });
  } catch (err) {
    console.error('externalLeads.list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.designations = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const filters = [
      'l.PUSHED_BATCH_CODE IS NULL',
      "l.DESIGNATION IS NOT NULL AND LTRIM(RTRIM(l.DESIGNATION)) <> ''",
    ];
    scopeToMember(req, request, filters);

    const result = await request.query(`
      SELECT LTRIM(RTRIM(l.DESIGNATION)) AS DESIGNATION, COUNT(*) AS n
      FROM ${T} l
      WHERE ${filters.join(' AND ')}
      GROUP BY LTRIM(RTRIM(l.DESIGNATION))
      ORDER BY n DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('externalLeads.designations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.assign = async (req, res) => {
  try {
    const { ids, userCode } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No leads selected' });
    }
    if (!userCode) return res.status(400).json({ error: 'Assignee is required' });

    const pool = await poolPromise;
    const request = pool.request();

    // Level 5/6 are the working team; a head (1/2) isn't normally assignable, but
    // can always assign to themselves.
    const member = await pool.request()
      .input('uc', sql.VarChar(100), String(userCode))
      .input('me', sql.VarChar(100), req.user?.user_code || '')
      .query(`SELECT USER_CODE FROM ${USER} WHERE USER_CODE = @uc AND ACTIVE = 1 AND (ACCESS_LEVEL IN (5, 6) OR USER_CODE = @me)`);
    if (!member.recordset.length) {
      return res.status(400).json({ error: 'Assignee is not an active visitor team member' });
    }

    request.input('assignedTo', sql.VarChar(100), String(userCode));

    const safeIds = ids.map((id) => parseInt(id, 10)).filter((n) => Number.isInteger(n));
    if (safeIds.length === 0) return res.status(400).json({ error: 'Invalid lead IDs' });
    const idParams = safeIds.map((id, i) => { request.input(`lid_${i}`, sql.BigInt, id); return `@lid_${i}`; });

    const result = await request.query(`
      UPDATE ${T}
      SET ASSIGNED_TO_USER_CODE = @assignedTo,
          ASSIGNED_DATE         = GETDATE(),
          UPDATED_DATE          = GETDATE()
      WHERE LEAD_ID IN (${idParams.join(',')})
        AND PUSHED_BATCH_CODE IS NULL;

      SELECT @@ROWCOUNT AS updated;
    `);

    res.json({ success: true, updated: result.recordset[0].updated });
  } catch (err) {
    console.error('externalLeads.assign error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.reclassify = async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.body;
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const leadId = parseInt(id, 10);
    if (!Number.isInteger(leadId)) return res.status(400).json({ error: 'Invalid lead ID' });

    const pool = await poolPromise;
    const result = await pool.request()
      .input('leadId', sql.BigInt, leadId)
      .input('category', sql.VarChar(20), category)
      .query(`
        UPDATE ${T}
        SET CATEGORY = @category, UPDATED_DATE = GETDATE()
        WHERE LEAD_ID = @leadId;

        SELECT @@ROWCOUNT AS updated;
      `);

    if (!result.recordset[0].updated) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('externalLeads.reclassify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.addLeadLog = async (req, res) => {
  try {
    const { id } = req.params;
    const { actionType, nextFollowup, remarks, newStatus, callId, callStatus, callDuration } = req.body;
    const leadId = parseInt(id, 10);
    if (!Number.isInteger(leadId)) return res.status(400).json({ error: 'Invalid lead ID' });

    const userCode = req.user?.user_code || 'SYSTEM';
    const userName = req.user?.username || '';
    const pool = await poolPromise;
    const request = pool.request();

    request.input('leadId', sql.BigInt, leadId);
    request.input('actionType', sql.VarChar(30), actionType || null);
    request.input('nextFU', sql.Date, nextFollowup || null);
    request.input('remarks', sql.NVarChar(1000), remarks || null);
    request.input('userCode', sql.VarChar(100), userCode);
    request.input('userName', sql.NVarChar(200), userName);
    request.input('newStatus', sql.VarChar(30), newStatus || null);
    request.input('callId', sql.VarChar(100), callId || null);
    request.input('callStatus', sql.VarChar(30), callStatus || null);
    request.input('callDuration', sql.Int, Number.isInteger(callDuration) ? callDuration : null);

    if (nextFollowup) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (String(nextFollowup).split('T')[0] <= todayStr) {
        return res.status(400).json({ error: 'Follow-up date must be after today.' });
      }
      const cnt = await pool.request()
        .input('leadId', sql.BigInt, leadId)
        .query(`
          SELECT COUNT(*) AS n FROM ${LEAD_LOG}
          WHERE LEAD_ID = @leadId AND NEXT_FOLLOWUP >= CAST(GETDATE() AS DATE);
        `);
      if ((cnt.recordset[0]?.n || 0) >= 5) {
        return res.status(400).json({ error: 'This lead already has 5 pending follow-ups.' });
      }
    }

    const result = await request.query(`
      INSERT INTO ${LEAD_LOG}
        (LOG_ID, LEAD_ID, ACTION_TYPE, STATUS, NEXT_FOLLOWUP, REMARKS, USER_CODE, USER_NAME, CREATED_DATE, CALL_ID, CALL_STATUS, CALL_DURATION)
      VALUES
        (CONVERT(VARCHAR(36), NEWID()), @leadId, @actionType, @newStatus, @nextFU, @remarks, @userCode, @userName, GETDATE(), @callId, @callStatus, @callDuration);

      UPDATE ${T} SET UPDATED_DATE = GETDATE() WHERE LEAD_ID = @leadId;

      SELECT
        l.LEAD_ID, l.ASSIGNED_TO_USER_CODE,
        @newStatus AS CURRENT_STATUS, @remarks AS LAST_REMARK, GETDATE() AS LAST_ACTIVITY_DATE,
        @nextFU AS NEXT_FOLLOWUP
      FROM ${T} l WHERE l.LEAD_ID = @leadId;
    `);

    const rows = result.recordsets[result.recordsets.length - 1];
    res.json({ success: true, lead: rows[0] });
  } catch (err) {
    console.error('externalLeads.addLeadLog error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getLeadLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const leadId = parseInt(id, 10);
    if (!Number.isInteger(leadId)) return res.status(400).json({ error: 'Invalid lead ID' });

    const pool = await poolPromise;
    const result = await pool.request()
      .input('leadId', sql.BigInt, leadId)
      .query(`
        SELECT l.*,
          l.USER_CODE AS DONE_BY,
          l.USER_NAME AS DONE_BY_NAME
        FROM ${LEAD_LOG} l
        WHERE l.LEAD_ID = @leadId
        ORDER BY l.CREATED_DATE DESC;
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('externalLeads.getLeadLogs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
