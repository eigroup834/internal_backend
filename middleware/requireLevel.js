const { hasAccessLevel } = require('../utils/accessLevels');
module.exports = function requireLevel(...levels) {
  const allowed = levels.flat().map(Number);
  return (req, res, next) => {
    if (hasAccessLevel(req.user, allowed)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
};
