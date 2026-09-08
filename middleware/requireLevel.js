module.exports = function requireLevel(...levels) {
  const allowed = new Set(levels.flat().map(Number));
  return (req, res, next) => {
    const lvl = Number(req.user?.access_level);
    if (allowed.has(lvl)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
};
