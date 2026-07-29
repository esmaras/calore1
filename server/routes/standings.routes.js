const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();

// Race results are admin/referee-entered — not even the owning driver can
// edit their own finishing positions.
router.put("/points-table", requireAdmin, async (req, res) => {
  const { pointsTable } = req.body || {};
  if (!Array.isArray(pointsTable)) return res.status(400).json({ error: "pointsTable must be an array" });
  const season = await resolveSeason(req.query.season);
  const updated = await repo.updateItem(keys.season(season), { pointsTable });
  res.json(updated);
});

router.put("/:driverId", requireAdmin, async (req, res) => {
  const { driverId } = req.params;
  const { races } = req.body || {};
  if (!Array.isArray(races)) return res.status(400).json({ error: "races must be an array" });

  const season = await resolveSeason(req.query.season);
  const existing = await repo.getItem(keys.standings(driverId, season));
  const item = { ...keys.standings(driverId, season), itemType: itemTypes.STANDINGS, driverId, season, races };
  if (!existing) {
    const driver = await repo.getItem(keys.driver(driverId));
    if (!driver) return res.status(404).json({ error: "No such driver" });
  }
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
