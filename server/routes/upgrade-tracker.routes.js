const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin, requireSelfOrAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();

// Must be registered before /:driverId — otherwise "legend" would satisfy
// the :driverId pattern and this route would never be reached.
router.put("/legend", requireAdmin, async (req, res) => {
  const attrs = {};
  if (Array.isArray(req.body?.legend)) attrs.legend = req.body.legend;
  if (typeof req.body?.rule === "string") attrs.rule = req.body.rule;
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No fields provided" });
  const updated = await repo.updateItem(keys.upgradeTrackerLegend(), attrs);
  res.json(updated);
});

// Sponsor/modification stay admin/referee-controlled — a driver hitting
// this route (requireSelfOrAdmin lets them touch only their own row) can
// change their own upgrade picks but any sponsor/modification they send is
// silently ignored rather than applied, so the shared client save function
// (which always posts all three fields) can't smuggle those through.
// Budget/remainingBudget are never accepted here; they're always
// recomputed server-side in assemble.js.
//
// Deliberately no priority/availability check here — a pick always saves.
// Whether it's actually defensible given priority is a read-time, derived
// question (see computeCompliance in server/db/priority.js, wired in by
// assembleData): a driver who doesn't have priority for a part sees their
// own row flagged non-compliant immediately, and a driver who gets bumped
// later by a higher-priority claim sees the same flag, without either
// pick ever being blocked or silently reverted.
router.put("/:driverId", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const isAdmin = req.user.role === "admin";
  const { sponsor, upgrades, modification } = req.body || {};
  if (upgrades !== undefined && !Array.isArray(upgrades)) {
    return res.status(400).json({ error: "upgrades must be an array" });
  }

  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  const season = await resolveSeason(req.query.season);
  const existing = (await repo.getItem(keys.upgradeTracker(driverId, season))) || { sponsor: null, upgrades: [], modification: 0 };

  const item = {
    ...keys.upgradeTracker(driverId, season),
    itemType: itemTypes.UPGRADETRACKER,
    driverId,
    season,
    sponsor: isAdmin && sponsor !== undefined ? sponsor : existing.sponsor,
    upgrades: upgrades !== undefined ? upgrades : existing.upgrades,
    modification: isAdmin && modification !== undefined ? modification : existing.modification,
  };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
