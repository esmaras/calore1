const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin, requireSelfOrAdmin } = require("../auth/middleware");
const { resolveSeason, seasonEndedLock } = require("../db/currentSeason");

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
  const seasonItem = await repo.getItem(keys.season(season));
  if (seasonEndedLock(seasonItem)) return res.status(400).json({ error: "Season has ended — the Upgrade Tracker is locked" });
  const existing = (await repo.getItem(keys.upgradeTracker(driverId, season))) || { sponsor: null, upgrades: [], modification: 0 };

  const nextUpgrades = upgrades !== undefined ? upgrades : existing.upgrades;

  // Off-season catch-up: a driver whose new-season row was seeded from
  // what they finished the prior season holding (see createNextSeason in
  // season.routes.js) can only swap out so many of those cards, based on
  // their finishing position — carryoverUpgrades is that frozen starting
  // point, swapAllowance the frozen limit. Both are absent/null for a
  // driver with no such history (a brand-new season or a brand-new
  // driver), meaning no restriction. Counted as "how many carried-over
  // parts are no longer present," not array-position diffing, so
  // reordering picks or swapping two held parts' slots never counts
  // against the limit.
  if (Array.isArray(existing.carryoverUpgrades) && existing.swapAllowance != null) {
    const swapsUsed = existing.carryoverUpgrades.filter((p) => p != null && !nextUpgrades.includes(p)).length;
    if (swapsUsed > existing.swapAllowance) {
      return res.status(400).json({
        error: `You can only swap out ${existing.swapAllowance} upgrade card${existing.swapAllowance === 1 ? "" : "s"} this season — this would swap ${swapsUsed}.`,
      });
    }
  }

  const item = {
    ...keys.upgradeTracker(driverId, season),
    itemType: itemTypes.UPGRADETRACKER,
    driverId,
    season,
    sponsor: sponsor !== undefined ? sponsor : existing.sponsor,
    upgrades: nextUpgrades,
    modification: isAdmin && modification !== undefined ? modification : existing.modification,
    carryoverUpgrades: existing.carryoverUpgrades ?? null,
    swapAllowance: existing.swapAllowance ?? null,
  };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
