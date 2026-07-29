const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { getCurrentSeasonNumber } = require("../db/currentSeason");

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
  };
  await repo.putItem(item);
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
