const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { getCurrentSeasonNumber, seasonEndedLock } = require("../db/currentSeason");
const { assembleData } = require("../db/assemble");
const { expandPointsTable } = require("../db/ranking");

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

// Creates a brand-new season: seasonNumber auto-increments (no artificial
// cap — "unlimited seasons"), computed from whatever seasons already exist
// rather than tracked separately, so it can't drift out of sync with
// reality. Season creation is always manual (the "+ Add season" button,
// POST / below) — deliberately never an automatic side effect of any
// off-season lifecycle action, so an admin can't end up with an
// unexpected extra season they didn't ask for.
async function createNextSeason({ label }) {
  const all = await repo.getAll();
  const existingSeasons = all.filter((i) => i.itemType === itemTypes.SEASON);
  const nextSeasonNumber = existingSeasons.length ? Math.max(...existingSeasons.map((s) => s.seasonNumber)) + 1 : 1;
  // Sized to however many drivers actually exist right now, not just the
  // original 8-row default — a roster that's grown since (see
  // expandPointsTable) needs every position scoreable from day one.
  const currentDriverCount = all.filter((i) => i.itemType === itemTypes.DRIVER).length;

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
    pointsTable: expandPointsTable(DEFAULT_POINTS_TABLE, currentDriverCount),
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

  // Off-season catch-up: seed every driver's new-season Upgrade Tracker row
  // with what they finished the PRIOR season holding, once that season has
  // actually ended — Standings/the Upgrade Tracker both lock the moment a
  // season ends (see seasonEndedLock), so "final position"/"final upgrades"
  // are stable facts by then, not a still-moving target. Applies no matter
  // which action created this season — a plain "+ Add season" click gets
  // the same carryover as "End Off-Season & Begin Next Season", since a
  // driver's baseline shouldn't depend on which button happened to create
  // the season. carryoverUpgrades is the frozen baseline the swap-count
  // check in upgrade-tracker.routes.js diffs future edits against;
  // swapAllowance is this driver's finishing position looked up against
  // the swap-limit table, likewise frozen so a later edit to that table
  // can't retroactively change an allowance already in effect. A brand-new
  // driver with no entry in the prior season gets no carryover and no
  // limit (both null/empty), i.e. unrestricted, same as before.
  if (priorSeasonItem?.ended) {
    const priorAssembled = assembleData(all, priorSeasonNumber);
    const positionByDriverId = Object.fromEntries(priorAssembled.standings.drivers.map((d) => [d.driverId, d.position]));
    const swapLimitByPosition = Object.fromEntries(priorAssembled.offSeasonBudget.swapAllowanceTable.map((w) => [w.position, w.maxSwaps]));
    for (const entry of priorAssembled.upgradeTracker.entries) {
      const position = positionByDriverId[entry.driverId];
      // eslint-disable-next-line no-await-in-loop
      await repo.putItem({
        ...keys.upgradeTracker(entry.driverId, nextSeasonNumber),
        itemType: itemTypes.UPGRADETRACKER,
        driverId: entry.driverId,
        season: nextSeasonNumber,
        sponsor: null,
        upgrades: entry.upgrades,
        modification: 0,
        carryoverUpgrades: entry.upgrades,
        swapAllowance: position != null ? swapLimitByPosition[position] ?? null : null,
      });
    }
  }

  return item;
}

// Admin-only: create a new season on demand.
router.post("/", requireAdmin, async (req, res) => {
  const { label } = req.body || {};
  const item = await createNextSeason({ label });
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

// Ends a season: freezes its budget carryover (and each driver's visual
// identity — see below) for good, and opens FICC/tech reg voting for the
// resulting off-season (see server/db/voting.js). Until a season is
// ended, whatever the next season shows as each driver's rollover is
// computed live off this season's current remainingBudget + winnings (see
// assembleData/computeCarryoverByDriver) — so creating the next season
// early still tracks this one as it plays out. Ending it snapshots that
// math once, so it stops needing to be recomputed — and stops changing —
// the moment the admin says this season is actually done. Reversible via
// /reopen below, in case it was ended too early.
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
  // A driver's visual identity — name, driver number, its badge styling,
  // car color, backstory — is a global, never season-scoped record (see
  // server/db/keys.js `driver(driverId)`) — editing any of it after this
  // point would otherwise silently rewrite how this now-final season's
  // standings/results/hall of fame/voting record/Drivers-page-history
  // reads, including making a driver who had no number/icon back then
  // look like they'd always had one. Snapshotting exactly what each
  // driver looked like at the moment their season actually ended (see
  // driverIdentityResolver in server/db/assemble.js, which prefers this
  // snapshot over the live record for any season that has one) keeps
  // that record accurate no matter what a driver changes about
  // themselves later. Pulled from assembled.driversForViewedSeason rather
  // than re-deriving it here, since assembleData already resolves these
  // same fields for every driver in this season (and, at end-time,
  // nothing's frozen yet, so it's exactly today's live values).
  const driverIdentities = assembled.driversForViewedSeason.map((d) => ({
    driverId: d.driverId,
    driver: d.driver,
    driverNumber: d.driverNumber,
    numberFont: d.numberFont,
    numberBgShape: d.numberBgShape,
    numberBgColor: d.numberBgColor,
    carColor: d.carColor,
    backstory: d.backstory,
  }));

  const updated = await repo.updateItem(keys.season(seasonNumber), {
    ended: true,
    endedCarryoverByDriver: carryoverByDriver,
    endedDriverIdentities: driverIdentities,
  });
  res.json(updated);
});

// Closes this season's off-season for good: voting and the FICC Backlog
// (the only things left open once /end locks everything else — see
// seasonEndedLock) stop accepting writes. This is the one-way door out of
// the off-season state — a season can otherwise sit there indefinitely
// while voting/proposals happen.
//
// Deliberately does NOT create the next season or touch the current-season
// pointer — season creation is a separate, always-manual action (POST /,
// the "+ Add season" button), regardless of off-season state. It doesn't
// need to happen in any particular order either way: promoteToNextSeason
// (server/db/voting.js) already parks anything that resolves before the
// next season exists, applied automatically whenever it's eventually
// created; and createNextSeason() seeds Upgrade Tracker carryover off
// whatever the most recently-ended season is, whenever it's called.
router.post("/:seasonNumber/close-offseason", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  if (!existing.ended) return res.status(400).json({ error: "End the season before closing its off-season" });
  if (existing.offseasonEnded) return res.status(400).json({ error: "This season's off-season has already ended" });

  const updated = await repo.updateItem(keys.season(seasonNumber), { offseasonEnded: true });
  res.json(updated);
});

// Reverses /end: the season goes back to "in progress" (its next-season
// carryover recomputes live again instead of using the frozen snapshot,
// and driver identities shown for it track live edits again too — see
// driverIdentityResolver), and FICC/tech-reg voting for its off-season
// closes again — any votes already cast stay recorded, they just stop
// being actionable (no further resolution/promotion) until the season is
// ended again.
router.post("/:seasonNumber/reopen", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  if (!existing.ended) return res.status(400).json({ error: "Season is not ended" });
  if (existing.offseasonEnded) return res.status(400).json({ error: "This season's off-season has already ended — it can't be reopened" });

  const updated = await repo.updateItem(keys.season(seasonNumber), { ended: false, endedCarryoverByDriver: [], endedDriverIdentities: [] });
  res.json(updated);
});

// Partial update, not a whole-item PUT — the SEASON#n item also holds
// pointsTable, which /api/standings/points-table owns. A full-item
// overwrite here would silently wipe that out.
router.put("/:seasonNumber", requireAdmin, async (req, res) => {
  const seasonNumber = Number(req.params.seasonNumber);
  const existing = await repo.getItem(keys.season(seasonNumber));
  if (!existing) return res.status(404).json({ error: "No such season" });
  if (seasonEndedLock(existing)) return res.status(400).json({ error: "Season has ended — its configuration is locked" });

  const attrs = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) attrs[field] = req.body[field];
  }
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No editable fields provided" });
  const updated = await repo.updateItem(keys.season(seasonNumber), attrs);
  res.json(updated);
});

module.exports = router;
