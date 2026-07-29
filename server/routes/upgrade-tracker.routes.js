const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
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

// Sponsor/upgrade-card assignment is admin/referee-controlled — drivers
// don't self-assign upgrades. Budget/remainingBudget are never accepted
// here; they're always recomputed server-side in assemble.js.
router.put("/:driverId", requireAdmin, async (req, res) => {
  const { driverId } = req.params;
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
    sponsor: sponsor !== undefined ? sponsor : existing.sponsor,
    upgrades: upgrades !== undefined ? upgrades : existing.upgrades,
    modification: modification !== undefined ? modification : existing.modification,
  };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
