const { itemTypes } = require("./keys");

// Two drivers with equal totalPoints are ranked by comparing their own race
// finishes best-to-worst, pairwise (best vs best, next-best vs next-best,
// ...) — the first race-finish gap decides it. A missed/DNF race (null)
// counts as worse than any numeric finish. Returns 0 only when every
// comparison is exactly equal (a genuinely identical season).
function compareRaceHistory(racesA, racesB) {
  const sortedFinishes = (races) => [...(races || [])].map((p) => (p == null ? Infinity : p)).sort((x, y) => x - y);
  const a = sortedFinishes(racesA);
  const b = sortedFinishes(racesB);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const pa = a[i] ?? Infinity;
    const pb = b[i] ?? Infinity;
    if (pa !== pb) return pa - pb;
  }
  return 0;
}

// Mutates row.position on each row (same contract as before this tiebreak
// existed) — primary sort by totalPoints desc, tiebreak via
// compareRaceHistory. Rows only share a position when they're equal on
// both totalPoints AND every race-finish comparison.
function rankStandings(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    return compareRaceHistory(a.races, b.races);
  });
  let rank = 0, seen = 0, prev = null;
  for (const row of sorted) {
    seen++;
    const tiedWithPrev = prev != null && prev.totalPoints === row.totalPoints && compareRaceHistory(prev.races, row.races) === 0;
    if (!tiedWithPrev) rank = seen;
    row.position = rank;
    prev = row;
  }
}

// Builds ranked standings rows for an arbitrary season from the raw item
// list — shared by assemble.js (the viewed season) and priority.js (an
// earlier season, to compute next-season upgrade-pick priority) so scoring
// logic only lives in one place.
function buildStandingsRowsForSeason(items, seasonNumber, driverItems) {
  const seasonItem = items.find((i) => i.itemType === itemTypes.SEASON && i.seasonNumber === seasonNumber) || {};
  const pointsTable = seasonItem.pointsTable || [];
  const pointsLookup = Object.fromEntries(pointsTable.map((p) => [p.position, p.points]));
  const standingsByDriver = Object.fromEntries(
    items.filter((i) => i.itemType === itemTypes.STANDINGS && i.season === seasonNumber).map((s) => [s.driverId, s])
  );

  // Always sized to the season's current schedule, not whatever length
  // happened to be saved on the STANDINGS item — a race added to (or
  // removed from) the schedule after a driver's races were last saved
  // must not leave their row out of sync with the Standings/Race Results
  // headers, which are themselves derived from the schedule (see
  // assemble.js's raceLabels).
  const raceCount = (seasonItem.schedule || []).length;
  const rows = driverItems.map((d) => {
    const row = standingsByDriver[d.driverId] || { races: [] };
    const races = Array.from({ length: raceCount }, (_, i) => row.races?.[i] ?? null);
    let totalPoints = 0;
    for (const pos of races) {
      if (pos != null && pointsLookup[pos] != null) totalPoints += pointsLookup[pos];
    }
    return { driverId: d.driverId, driver: d.driver, team: d.teamName, races, totalPoints, position: 0 };
  });
  rankStandings(rows);
  return rows;
}

// A driver's DRIVER record is global, never season-scoped (it carries over
// season to season, same as the upgrade-parts/sponsor inventory) — but a
// driver added mid-campaign must not retroactively appear in an earlier
// (especially already-ended) season's standings/roster/vote count just
// because they exist NOW, and a driver removed later must not disappear
// from a season they actually raced in. joinedSeason/leftSeason (see
// POST/DELETE /api/admin/drivers) are the cutoffs: a driver counts for
// `seasonNumber` only once seasonNumber >= joinedSeason AND (they haven't
// left, or seasonNumber is still before leftSeason). Missing joinedSeason
// (every driver created before this field existed) defaults to -Infinity,
// i.e. "always existed" — preserves today's behavior for the existing
// roster exactly, no backfill/migration needed. A driver is never actually
// deleted once they have any real history — see DELETE /drivers/:driverId
// — specifically so this filter is enough on its own to keep past seasons
// intact; there's no separate "did this DRIVER record even exist back
// then" concern to worry about.
function driversAsOfSeason(driverItems, seasonNumber) {
  return driverItems.filter(
    (d) => (d.joinedSeason ?? -Infinity) <= seasonNumber && (d.leftSeason == null || seasonNumber < d.leftSeason)
  );
}

// A season's points-per-position table needs one row per possible
// finishing position — i.e. at least as many rows as there are drivers.
// Adding a driver (or, less commonly, starting with fewer than the
// default lineup) means the table needs to grow to cover the new position;
// existing rows are never touched, only positions missing beyond what's
// already there are appended, defaulting to 0 points — same convention
// the table's own lowest existing rows already use.
function expandPointsTable(pointsTable, driverCount) {
  const existingPositions = new Set((pointsTable || []).map((p) => p.position));
  const expanded = [...(pointsTable || [])];
  for (let position = 1; position <= driverCount; position++) {
    if (!existingPositions.has(position)) expanded.push({ position, points: 0 });
  }
  return expanded;
}

module.exports = { compareRaceHistory, rankStandings, buildStandingsRowsForSeason, driversAsOfSeason, expandPointsTable };
