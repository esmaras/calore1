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

  const rows = driverItems.map((d) => {
    const row = standingsByDriver[d.driverId] || { races: [] };
    const races = row.races || [];
    let totalPoints = 0;
    for (const pos of races) {
      if (pos != null && pointsLookup[pos] != null) totalPoints += pointsLookup[pos];
    }
    return { driverId: d.driverId, driver: d.driver, team: d.teamName, races, totalPoints, position: 0 };
  });
  rankStandings(rows);
  return rows;
}

module.exports = { compareRaceHistory, rankStandings, buildStandingsRowsForSeason };
