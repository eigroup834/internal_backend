function getAccessLevels(user) {
  const value = user && typeof user === "object" && !Array.isArray(user)
    ? (user.access_levels ?? user.ACCESS_LEVELS ?? user.access_level ?? user.ACCESS_LEVEL) : user;
  let values = value;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch { values = values.split(","); }
  }
  if (!Array.isArray(values)) values = [values];
  return [...new Set(values.filter(v => typeof v === "number" || typeof v === "string")
    .map(Number).filter(v => Number.isInteger(v) && v >= 1 && v <= 7))];
}
function hasAccessLevel(user, allowed) {
  return getAccessLevels(user).some(level => allowed.includes(level));
}

function validateAccessLevels(value) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some(v => !/^[1-7]$/.test(String(v)))) throw new Error("Select at least one valid access level (1-7).");
  return getAccessLevels(values);
}
module.exports = { getAccessLevels, hasAccessLevel, validateAccessLevels };
