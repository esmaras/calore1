const express = require("express");
const repo = require("../db/repo");
const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();
const itemsOnly = (body) => ({ items: body.items });

router.use("/regulations", blobRoute(keys.offSeasonRegulations, itemTypes.OFFSEASON_REGULATIONS, itemsOnly));
router.use("/driver-tracker", blobRoute(keys.offSeasonDriverTracker, itemTypes.OFFSEASON_DRIVERTRACKER, itemsOnly));
router.use("/mid-season-window", blobRoute(keys.offSeasonMidSeasonWindow, itemTypes.OFFSEASON_MIDSEASONWINDOW, itemsOnly));

// One deterministic winnings figure per driver per season, keyed off that
// season's own final standings (rendered as a row-per-driver list on the
// Off-Season Budget page) — this is what season creation reads to seed
// next season's starting budget, not the freeform regulations/tracker
// tables above.
router.put("/winnings/:driverId", requireAdmin, async (req, res) => {
  const { driverId } = req.params;
  const { winnings } = req.body || {};
  if (typeof winnings !== "number" && winnings !== null) {
    return res.status(400).json({ error: "winnings must be a number or null" });
  }
  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  const season = await resolveSeason(req.query.season);
  const item = { ...keys.offSeasonWinnings(driverId, season), itemType: itemTypes.OFFSEASON_WINNINGS, driverId, season, winnings };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
