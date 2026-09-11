const express = require("express");
const repo = require("../db/repo");
const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();
const itemsOnly = (body) => ({ items: body.items });

router.use("/regulations", blobRoute(keys.offSeasonRegulations, itemTypes.OFFSEASON_REGULATIONS, itemsOnly));

// One deterministic winnings figure per finishing position per season
// (rendered as a row-per-driver list, ordered by position, on the
// Off-Season Budget page) — this is what season creation reads to seed
// next season's starting budget, not the freeform regulations/tracker
// tables above. Keyed on position rather than driverId so a standings
// correction after the fact moves the payout to whoever now holds that
// position instead of leaving it stuck on the driver who held it when the
// amount was entered (see keys.offSeasonWinnings).
router.put("/winnings/:position", requireAdmin, async (req, res) => {
  const position = Number(req.params.position);
  const { winnings } = req.body || {};
  if (!Number.isInteger(position) || position < 1) {
    return res.status(400).json({ error: "position must be a positive integer" });
  }
  if (typeof winnings !== "number" && winnings !== null) {
    return res.status(400).json({ error: "winnings must be a number or null" });
  }

  const season = await resolveSeason(req.query.season);
  const item = { ...keys.offSeasonWinnings(position, season), itemType: itemTypes.OFFSEASON_WINNINGS, position, season, winnings };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
