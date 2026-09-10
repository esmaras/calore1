const { sign, verify } = require("./cookies");
const config = require("../config");

const COOKIE_NAME = "calore1_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

function setSessionCookie(res, payload) {
  const token = sign(payload, config.sessionSecret);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: SESSION_MS,
  });
}

function requireAuth(req, res, next) {
  const payload = identifyUser(req);
  if (!payload) return res.status(401).json({ error: "Not authenticated" });
  req.user = payload; // { username, role, driverId, issuedAt, expiresAt }
  next();
}

// Same cookie decode as requireAuth, but never rejects — returns null for
// a guest/invalid session instead of a 401. Used by routes that are
// intentionally public (GET /api/data) but still want to know who's
// asking when someone happens to be logged in, e.g. to reveal a driver's
// own FICC/tech-reg vote without exposing anyone else's (see
// buildVotingView in server/db/voting.js).
function identifyUser(req) {
  const token = req.cookies?.[COOKIE_NAME];
  return verify(token, config.sessionSecret);
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// 403 unless the caller is admin or the :paramName route param equals
// their own driverId. Routes using this must be scoped to a single
// driver's item by that param — this is what makes "a driver can only
// touch their own record" a structural guarantee, not just a UI hint.
function requireSelfOrAdmin(paramName) {
  return (req, res, next) => {
    if (req.user?.role === "admin" || req.user?.driverId === req.params[paramName]) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

module.exports = { COOKIE_NAME, SESSION_MS, SESSION_DAYS, setSessionCookie, requireAuth, requireAdmin, requireSelfOrAdmin, identifyUser };
