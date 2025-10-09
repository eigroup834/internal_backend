const { getConnection, sql } = require("./db");
const useragent = require("useragent");

async function logActivity({
  userCode = "GUEST",
  role = "PUBLIC",
  activityType = "UNKNOWN",
  activityDescription = "",
  moduleName = "",
  actionStatus = "SUCCESS",
  ipAddress = "",
  userAgent = "",
}) {
  try {
    const pool = await getConnection();
    const agent = useragent.parse(userAgent || "");
    const deviceInfo = `${agent.family} ${agent.major} on ${agent.os.family}`;

    await pool.request()
      .input("CODE", sql.VarChar, userCode)
      .input("ROLE", sql.VarChar, role)
      .input("ACTIVITY_TYPE", sql.VarChar, activityType)
      .input("ACTIVITY_DESCRIPTION", sql.VarChar, activityDescription)
      .input("MODULE_NAME", sql.VarChar, moduleName)
      .input("ACTION_STATUS", sql.VarChar, actionStatus)
      .input("IP_ADDRESS", sql.VarChar, ipAddress)
      .input("DEVICE_INFO", sql.VarChar, deviceInfo)
      .query(`
        INSERT INTO [dbo].[DEVP_APP_LOG]
        ([CODE],[ROLE],[ACTIVITY_TYPE],[ACTIVITY_DESCRIPTION],
         [MODULE_NAME],[ACTION_STATUS],[IP_ADDRESS],[DEVICE_INFO],[CREATED_DATE])
        VALUES (@CODE,@ROLE,@ACTIVITY_TYPE,@ACTIVITY_DESCRIPTION,
                @MODULE_NAME,@ACTION_STATUS,@IP_ADDRESS,@DEVICE_INFO,GETDATE())
      `);
  } catch (err) {
    console.error("Failed to log activity:", err.message);
  }
}

module.exports = { logActivity };
