const { logActivity } = require("../logger");

function activityLogger(req, res, next) {
  const startTime = Date.now();

  res.on("finish", async () => {
    try {
      const user = req.user || {}; 
      const status = res.statusCode < 400 ? "SUCCESS" : "FAILURE";

      const logData = {
        userCode: user.id || "GUEST",
        role: user.role || "PUBLIC",
        activityType: req.method, 
        activityDescription: `${req.method} ${req.originalUrl}`,
        moduleName: getModuleName(req.originalUrl),
        actionStatus: status,
        ipAddress: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
      };

      await logActivity(logData);

      const duration = Date.now() - startTime;
      console.log(`[${logData.activityType}] ${logData.activityDescription} - ${status} (${duration}ms)`);
    } catch (err) {
      console.error("Auto log failed:", err.message);
    }
  });

  next();
}

function getModuleName(url) {
  if (url.startsWith("/auth")) return "Authentication";
  if (url.startsWith("/users")) return "User Management";
  if (url.startsWith("/admin")) return "Admin Panel";
  if (url.startsWith("/reports")) return "Reports";
  return "General";
}

module.exports = { activityLogger };
