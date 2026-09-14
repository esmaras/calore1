const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { resolveSeason, seasonEndedLock } = require("../db/currentSeason");

const router = express.Router();

// Race results are admin/referee-entered — not even the owning driver can
// edit their own finishing positions.
router.put("/points-table", requireAdmin, async (req, res) => {
  const { pointsTable } = req.body || {};
  if (!Array.isArray(pointsTable)) return res.status(400).json({ error: "pointsTable must be an array" });
  const season = await resolveSeason(req.query.season);
  const seasonItem = await repo.getItem(keys.season(season));
  if (seasonEndedLock(seasonItem)) return res.status(400).json({ error: "Season has ended — race results are locked" });
  const updated = await repo.updateItem(keys.season(season), { pointsTable });
  res.json(updated);
});

router.put("/:driverId", requireAdmin, async (req, res) => {
  const { driverId } = req.params;
  const { races } = req.body || {};
  if (!Array.isArray(races)) return res.status(400).json({ error: "races must be an array" });

  const season = await resolveSeason(req.query.season);
  const seasonItem = await repo.getItem(keys.season(season));
  if (seasonEndedLock(seasonItem)) return res.status(400).json({ error: "Season has ended — race results are locked" });

  // No ties within a race — each finishing position in a given race can
  // only belong to one driver. Checked against every other driver's
  // current results for this season, not just saved-then-flagged like the
  // Upgrade Tracker's cross-driver priority checks, since a finishing
  // order with two cars in the same position isn't a real result at all.
  const all = await repo.getAll();
  const driverName = Object.fromEntries(all.filter((i) => i.itemType === itemTypes.DRIVER).map((d) => [d.driverId, d.driver]));
  const others = all.filter((i) => i.itemType === itemTypes.STANDINGS && i.season === season && i.driverId !== driverId);
  for (let i = 0; i < races.length; i++) {
    const pos = races[i];
    if (pos == null) continue;
    const conflict = others.find((o) => (o.races || [])[i] === pos);
    if (conflict) {
      return res.status(400).json({
        error: `Position ${pos} in Race ${i + 1} is already held by ${driverName[conflict.driverId] || conflict.driverId} — no ties within a race.`,
      });
    }
  }

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
