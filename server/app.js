const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { requireAuth, requireAdmin } = require("./auth/middleware");

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

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
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
app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);

module.exports = app;
