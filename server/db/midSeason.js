const { itemTypes } = require("./keys");
const { buildStandingsRowsForSeason } = require("./ranking");

// In-season upgrade exchange rules. Everything here is derived at read
// time from the season config and posted race results. Nothing about the
// phase is stored, so editing the schedule, the mid-season break, or a race
// result just moves the season to whatever phase that data now implies.
//
// Phases:
//   preseason       — no race results yet: picks are open (subject to the
//                     off-season carryover swap allowance).
//   locked          — some results posted, mid-season break race not yet:
//                     drivers can't change upgrades or sponsor.
//   midseasonWindow — the break race has results, the next race doesn't:
//                     the bottom-X teams (standings through the break race)
//                     can swap up to N upgrade cards, and every team can
//                     change sponsor.
//   postMidseason   — the race after the break has results: locked again.
// Admin is always exempt (enforced in upgrade-tracker.routes.js).

const DEFAULT_RULES = {
  lockUpgradesAfterFirstRace: true,
  midSeasonSwapTeams: 4,
  midSeasonMaxSwaps: 2,
  midSeasonFunding: 3000000,
};

function resolveRules(seasonItem) {
  const s = seasonItem || {};
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    lockUpgradesAfterFirstRace: typeof s.lockUpgradesAfterFirstRace === "boolean" ? s.lockUpgradesAfterFirstRace : DEFAULT_RULES.lockUpgradesAfterFirstRace,
    midSeasonSwapTeams: num(s.midSeasonSwapTeams, DEFAULT_RULES.midSeasonSwapTeams),
    midSeasonMaxSwaps: num(s.midSeasonMaxSwaps, DEFAULT_RULES.midSeasonMaxSwaps),
    midSeasonFunding: num(s.midSeasonFunding, DEFAULT_RULES.midSeasonFunding),
  };
}

// Half the schedule, rounded up (8 races -> 4, 7 races -> 4).
function defaultMidwayRace(raceCount) {
  return raceCount >= 2 ? Math.ceil(raceCount / 2) : null;
}

// The admin-set "Mid-season break after race #" wins when it points at a
// real race in the schedule. Otherwise (blank, or out of range after the
// schedule shrank) fall back to half the schedule.
function midwayRace(seasonItem) {
  const raceCount = (seasonItem?.schedule || []).length;
  const set = Number(seasonItem?.midSeasonBreakAfterRace);
  if (seasonItem?.midSeasonBreakAfterRace != null && Number.isInteger(set) && set >= 1 && set <= raceCount) return set;
  return defaultMidwayRace(raceCount);
}

function seasonStandingsItems(items, seasonNumber) {
  return items.filter((i) => i.itemType === itemTypes.STANDINGS && i.season === seasonNumber);
}

// raceIdx is 0-based.
function raceHasResults(items, seasonNumber, raceIdx) {
  return seasonStandingsItems(items, seasonNumber).some((s) => (s.races || [])[raceIdx] != null);
}

function computeSeasonPhase(items, seasonNumber) {
  const seasonItem = items.find((i) => i.itemType === itemTypes.SEASON && i.seasonNumber === seasonNumber) || {};
  const raceCount = (seasonItem.schedule || []).length;
  const midway = midwayRace(seasonItem);
  const rows = seasonStandingsItems(items, seasonNumber);
  const anyResults = rows.some((s) => (s.races || []).slice(0, raceCount || undefined).some((r) => r != null));

  let phase = "preseason";
  if (anyResults) {
    phase = "locked";
    if (midway != null && raceHasResults(items, seasonNumber, midway - 1)) {
      phase = raceHasResults(items, seasonNumber, midway) ? "postMidseason" : "midseasonWindow";
    }
  }
  return { phase, midwayRace: midway, defaultMidwayRace: defaultMidwayRace(raceCount), raceCount };
}

function midwayReached(phase) {
  return phase === "midseasonWindow" || phase === "postMidseason";
}

// Strict bottom X from standings through the break race only — ties that
// survive the normal tiebreakers fall back to roster order (later in the
// roster counts as lower), so exactly X teams qualify. Empty until the
// break race has results.
function computeMidSeasonEligible(items, seasonNumber, driverItems, teams, phaseInfo = null) {
  const info = phaseInfo || computeSeasonPhase(items, seasonNumber);
  if (!midwayReached(info.phase) || !teams) return new Set();
  const rows = buildStandingsRowsForSeason(items, seasonNumber, driverItems, { throughRace: info.midwayRace });
  const rosterIdx = new Map(driverItems.map((d, i) => [d.driverId, i]));
  const ordered = [...rows].sort((a, b) => a.position - b.position || rosterIdx.get(a.driverId) - rosterIdx.get(b.driverId));
  return new Set(ordered.slice(Math.max(0, ordered.length - teams)).map((r) => r.driverId));
}

// How many of the parts a driver held going into the window are gone now.
function countSwaps(baseline, upgrades) {
  if (!Array.isArray(baseline)) return 0;
  return baseline.filter((p) => p != null && !(upgrades || []).includes(p)).length;
}

module.exports = {
  DEFAULT_RULES,
  resolveRules,
  midwayRace,
  defaultMidwayRace,
  raceHasResults,
  computeSeasonPhase,
  midwayReached,
  computeMidSeasonEligible,
  countSwaps,
};
