const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { getCurrentSeasonNumber } = require("../db/currentSeason");
const { assembleData } = require("../db/assemble");

const router = express.Router();

const EDITABLE_FIELDS = [
  "label",
  "racesThisSeason",
  "upgradeSlots",
  "trackSelectionMethod",
  "midSeasonBreakAfterRace",
  "legends",
  "baseTeamBudget",
  "schedule",
  "allowedTiers",
  "disallowedTypes",
];

// The scoring lookup table (position -> points) is a sensible default for
// a brand-new season, not something you'd want to start from scratch —
// matches the original 1961 season's rules.
const DEFAULT_POINTS_TABLE = [
  { position: 1, points: 9 },
  { position: 2, points: 6 },
  { position: 3, points: 4 },
  { position: 4, points: 3 },
  { position: 5, points: 2 },
  { position: 6, points: 1 },
  { position: 7, points: 0 },
  { position: 8, points: 0 },
];

// Admin-only: create a new season. seasonNumber auto-increments (no
// artificial cap — "unlimited seasons"), computed from whatever seasons
// already exist rather than tracked separately, so it can't drift out of
// sync with reality.
router.post("/", requireAdmin, async (req, res) => {
  const all = await repo.getAll();
  const existingSeasons = all.filter((i) => i.itemType === itemTypes.SEASON);
  const nextSeasonNumber = existingSeasons.length ? Math.max(...existingSeasons.map((s) => s.seasonNumber)) + 1 : 1;

  const { label } = req.body || {};
  const item = {
    ...keys.season(nextSeasonNumber),
    itemType: itemTypes.SEASON,
    seasonNumber: nextSeasonNumber,
    label: label && String(label).trim() ? String(label).trim() : String(nextSeasonNumber),
    racesThisSeason: 0,
    upgradeSlots: 3,
    trackSelectionMethod: "",
    midSeasonBreakAfterRace: null,
    legends: "No",
    baseTeamBudget: 0,
    schedule: [],
    raceLabels: [],
    pointsTable: DEFAULT_POINTS_TABLE,
    // Empty means "no restriction" — allowedTiers as an inclusion list,
    // disallowedTypes as an exclusion list, per how admins described
    // wanting to configure each (which tiers ARE in, which types are OUT).
    allowedTiers: [],
    disallowedTypes: [],
  };
  await repo.putItem(item);

  // Inherit any technical regulations that were auto-promoted (FICC
  // proposals that passed their vote, or expiring regs that were renewed)
  // while this was the next season but didn't exist yet — see
  // promoteToNextSeason in server/db/voting.js, which parks these on the
  // season they were voted during whenever the following season isn't
  // created yet at the moment a vote resolves.
  const priorSeasonNumber = existingSeasons.length ? Math.max(...existingSeasons.map((s) => s.seasonNumber)) : null;
  const priorSeasonItem = priorSeasonNumber != null ? existingSeasons.find((s) => s.seasonNumber === priorSeasonNumber) : null;
  if (priorSeasonItem?.promotedRegs?.length) {
    await repo.putItem({
      ...keys.techRegs(nextSeasonNumber),
      itemType: itemTypes.TECHREGS,
      season: nextSeasonNumber,
      items: priorSeasonItem.promotedRegs,
    });
  }

  res.json(item);
});

// Must be registered before /:seasonNumber below.
router.post("/:seasonNumber/set-current", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  await repo.putItem({ ...keys.currentSeasonPointer(), itemType: itemTypes.CURRENTSEASON_POINTER, seasonNumber });
  res.json({ currentSeasonNumber: seasonNumber });
});

// Ends a season: freezes its budget carryover for good, and opens FICC/tech
// reg voting for the resulting off-season (see server/db/voting.js). Until
// a season is ended, whatever the next season shows as each driver's
// rollover is computed live off this season's current remainingBudget +
// winnings (see assembleData/computeCarryoverByDriver) — so creating the
// next season early still tracks this one as it plays out. Ending it
// snapshots that math once, so it stops needing to be recomputed — and
// stops changing — the moment the admin says this season is actually done.
// Reversible via /reopen below, in case it was ended too early.
router.post("/:seasonNumber/end", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  if (existing.ended) return res.status(400).json({ error: "Season has already ended" });

  const all = await repo.getAll();
  const assembled = assembleData(all, seasonNumber);
  const winningsByDriverId = Object.fromEntries(assembled.offSeasonBudget.winningsByDriver.map((w) => [w.driverId, w.winnings || 0]));
  const carryoverByDriver = assembled.upgradeTracker.entries.map((e) => ({
    driverId: e.driverId,
    carryover: (e.remainingBudget || 0) + (winningsByDriverId[e.driverId] || 0),
  }));

  const updated = await repo.updateItem(keys.season(seasonNumber), { ended: true, endedCarryoverByDriver: carryoverByDriver });
  res.json(updated);
});

// Reverses /end: the season goes back to "in progress" (its next-season
// carryover recomputes live again instead of using the frozen snapshot),
// and FICC/tech-reg voting for its off-season closes again — any votes
// already cast stay recorded, they just stop being actionable (no further
// resolution/promotion) until the season is ended again.
router.post("/:seasonNumber/reopen", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  if (!existing.ended) return res.status(400).json({ error: "Season is not ended" });

  const updated = await repo.updateItem(keys.season(seasonNumber), { ended: false, endedCarryoverByDriver: [] });
  res.json(updated);
});

// Partial update, not a whole-item PUT — the SEASON#n item also holds
// pointsTable/raceLabels, which /api/standings/points-table owns. A
// full-item overwrite here would silently wipe those out.
router.put("/:seasonNumber", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });

  const attrs = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) attrs[field] = req.body[field];
  }
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No editable fields provided" });
  const updated = await repo.updateItem(keys.season(seasonNumber), attrs);
  res.json(updated);
});

module.exports = router;
