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

// Modification stays admin/referee-controlled — a driver hitting this
// route (requireSelfOrAdmin lets them touch only their own row) can
// change their own sponsor/upgrade picks but any modification they send is
// silently ignored rather than applied, so the shared client save function
// (which always posts all three fields) can't smuggle it through.
// Budget/remainingBudget are never accepted here; they're always
// recomputed server-side in assemble.js.
//
// Deliberately no cross-driver priority/availability check here — a pick
// against another driver always saves. Whether it's actually defensible
// given priority is a read-time, derived question (see computeCompliance
// and computeSponsorCompliance in server/db/priority.js, wired in by
// assembleData): a driver who doesn't have priority for a part or sponsor
// sees their own row flagged non-compliant immediately, and a driver who
// gets bumped later by a higher-priority claim sees the same flag,
// without either pick ever being blocked or silently reverted. The
// one-type-per-driver rule below is different — it's not a contest with
// anyone else, so it's simpler and clearer to just reject it outright.
router.put("/:driverId", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const isAdmin = req.user.role === "admin";
  const { sponsor, upgrades, modification } = req.body || {};
  if (upgrades !== undefined && !Array.isArray(upgrades)) {
    return res.status(400).json({ error: "upgrades must be an array" });
  }

  // One upgrade per type, no matter which specific part — two different
  // Tires cards (or two copies of the same part) are just as disallowed
  // as the same part twice. Unlike the cross-driver priority/compliance
  // check (see server/db/priority.js), this is purely within one driver's
  // own picks, so it can be checked and rejected outright here rather
  // than saved-then-flagged.
  if (Array.isArray(upgrades)) {
    const all = await repo.getAll();
    const typeByPart = new Map(all.filter((i) => i.itemType === itemTypes.UPGRADEPART).map((u) => [u.partNumber, u.type]));
    const seenTypes = new Map(); // type -> the partNumber already claiming it
    for (const partNumber of upgrades) {
      if (partNumber == null) continue;
      const num = Number(partNumber);
      const type = typeByPart.get(num);
      if (type == null) continue; // unknown part number — nothing to compare against
      if (seenTypes.has(type)) {
        const other = seenTypes.get(type);
        const error = other === num
          ? `Can't have two copies of the same upgrade (#${num}).`
          : `Can't have two ${type} upgrades — #${num} conflicts with #${other}.`;
        return res.status(400).json({ error });
      }
      seenTypes.set(type, num);
    }
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
    modification: isAdmin && modification !== undefined ? modification : existing.modification,
  };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
