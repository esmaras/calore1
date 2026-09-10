const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { requireAuth, requireAdmin, identifyUser } = require("./auth/middleware");
const actorContext = require("./auth/actorContext");

const authRoutes = require("./routes/auth.routes");
const dataRoutes = require("./routes/data.routes");
const driversRoutes = require("./routes/drivers.routes");
const standingsRoutes = require("./routes/standings.routes");
const upgradeTrackerRoutes = require("./routes/upgrade-tracker.routes");
const loreRoutes = require("./routes/lore.routes");
const seasonRoutes = require("./routes/season.routes");
const techRegsRoutes = require("./routes/techregs.routes");
const ficcRoutes = require("./routes/ficc.routes");
const offSeasonRoutes = require("./routes/offseason.routes");
const hallOfFameRoutes = require("./routes/halloffame.routes");
const adminRoutes = require("./routes/admin.routes");
const auditLogRoutes = require("./routes/auditlog.routes");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Makes "who's making this request" available to server/db/repo.js for
// audit logging, without threading a user object through every write call
// — see server/auth/actorContext.js. Runs for every request (even public
// ones) so it's in place before any route handler, including ones that
// don't themselves require auth.
app.use((req, res, next) => {
  const user = identifyUser(req);
  actorContext.run({ username: user?.username ?? null, role: user?.role ?? null }, next);
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRoutes);

// GET /api/data is intentionally public — anonymous visitors get the same
// read-only view a logged-in driver already sees on admin-managed
// sections (isAdmin()/isSelfOrAdmin() on the client both treat a missing
// session as "no permissions", so nothing editable renders for them).
// Every other route below still requires a logged-in session — this file
// has no write routes (see server/routes/data.routes.js).
app.use("/api/data", dataRoutes);

// Everything under /api past this point requires a logged-in session.
// Per-route requireAdmin / requireSelfOrAdmin checks (inside each router)
// layer on top of this for who can write what.
app.use("/api/drivers", requireAuth, driversRoutes);
app.use("/api/standings", requireAuth, standingsRoutes);
app.use("/api/upgrade-tracker", requireAuth, upgradeTrackerRoutes);
app.use("/api/lore", requireAuth, loreRoutes);
app.use("/api/season", requireAuth, seasonRoutes);
app.use("/api/techregs", requireAuth, techRegsRoutes);
app.use("/api/ficc", requireAuth, ficcRoutes);
app.use("/api/offseason", requireAuth, offSeasonRoutes);
app.use("/api/halloffame", requireAuth, hallOfFameRoutes);
// Mounted before the general /api/admin router below — a path-prefix
// match on /api/admin alone would otherwise intercept this first and fall
// through via its router's own 404, which works but is needlessly
// roundabout; being more specific first is clearer.
app.use("/api/admin/audit-log", requireAuth, requireAdmin, auditLogRoutes);
app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);

module.exports = app;
