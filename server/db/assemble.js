const { itemTypes } = require("./keys");

function strip(item) {
  if (!item) return item;
  const { PK, SK, itemType, ...rest } = item;
  return rest;
}

function groupByItemType(items) {
  const byType = {};
  for (const item of items) {
    (byType[item.itemType] ||= []).push(item);
  }
  return byType;
}

function computeUpgradeCost(upgradeParts, partNumber) {
  const u = upgradeParts.find((u) => u.partNumber === Number(partNumber));
  return u && typeof u.cost === "number" ? u.cost : 0;
}

function sponsorFunding(sponsors, sponsorName) {
  if (!sponsorName) return 0;
  const s = sponsors.find((s) => s.name === sponsorName);
  return s && typeof s.funding === "number" ? s.funding : 0;
}

function rankStandings(rows) {
  const sorted = [...rows].sort((a, b) => b.totalPoints - a.totalPoints);
  let rank = 0, prevPoints = null, seen = 0;
  for (const row of sorted) {
    seen++;
    if (row.totalPoints !== prevPoints) { rank = seen; prevPoints = row.totalPoints; }
    row.position = rank;
  }
}

// Turns the flat array of DynamoDB items (as returned by repo.getAll())
// into the same aggregate shape the client (public/app.js) has always
// consumed. Derived fields (standings totalPoints/position, upgrade
// tracker budget/remainingBudget) are computed here every time, never
// read from storage — closes the class of bugs where a stale stored
// value drifts from the fields it's derived from.
//
// `viewedSeason` selects which season's Standings/Upgrade Tracker/FICC
// Backlog data to assemble — driver roster, inventory, lore, technical
// regs, hall of fame, and off-season budget are NOT season-scoped (they
// carry over season to season), only those three sections are.
function assembleData(items, viewedSeason) {
  const byType = groupByItemType(items);
  const one = (type) => strip((byType[type] || [])[0]);
  const bySeason = (type, season) => (byType[type] || []).filter((i) => i.season === season);

  const driverItems = [...(byType[itemTypes.DRIVER] || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const driverIds = driverItems.map((d) => d.driverId);
  const driverById = Object.fromEntries(driverItems.map((d) => [d.driverId, d]));

  const allSeasonItems = (byType[itemTypes.SEASON] || []).map(strip).sort((a, b) => a.seasonNumber - b.seasonNumber);
  const currentSeasonNumber = (one(itemTypes.CURRENTSEASON_POINTER) || {}).seasonNumber ?? allSeasonItems[0]?.seasonNumber ?? 1;
  const seasonNumber = viewedSeason ?? currentSeasonNumber;
  const seasonItem = allSeasonItems.find((s) => s.seasonNumber === seasonNumber) || {};

  const pointsTable = seasonItem.pointsTable || [];
  const raceLabels = seasonItem.raceLabels || [];
  const pointsLookup = Object.fromEntries(pointsTable.map((p) => [p.position, p.points]));

  const upgradeParts = (byType[itemTypes.UPGRADEPART] || []).map(strip).sort((a, b) => a.partNumber - b.partNumber);
  const sponsors = (byType[itemTypes.SPONSOR] || []).map(strip);
  const carColors = (byType[itemTypes.CARCOLORCONFIG] || [])
    .map(strip)
    .filter((c) => c.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  const standingsByDriver = Object.fromEntries(bySeason(itemTypes.STANDINGS, seasonNumber).map((s) => [s.driverId, s]));
  const upgradeTrackerByDriver = Object.fromEntries(bySeason(itemTypes.UPGRADETRACKER, seasonNumber).map((u) => [u.driverId, u]));
  const ficcProposalByDriver = Object.fromEntries(bySeason(itemTypes.FICC_PROPOSAL, seasonNumber).map((p) => [p.driverId, p]));
  const usernameByDriverId = Object.fromEntries(
    (byType[itemTypes.USER] || []).filter((u) => u.role === "driver" && u.driverId).map((u) => [u.driverId, u.username])
  );

  // ---- standings ----
  const standingsRows = driverIds.map((driverId) => {
    const driver = driverById[driverId];
    const row = standingsByDriver[driverId] || { races: [] };
    const races = row.races || [];
    let totalPoints = 0;
    for (const pos of races) {
      if (pos != null && pointsLookup[pos] != null) totalPoints += pointsLookup[pos];
    }
    return { driver: driver.driver, team: driver.teamName, races, totalPoints, position: 0 };
  });
  rankStandings(standingsRows);

  // ---- upgrade tracker ----
  const legendItem = one(itemTypes.UPGRADETRACKER_LEGEND) || {};
  const upgradeEntries = driverIds.map((driverId) => {
    const driver = driverById[driverId];
    const row = upgradeTrackerByDriver[driverId] || { sponsor: null, upgrades: [], modification: 0 };
    const budget = (seasonItem.baseTeamBudget || 0) + sponsorFunding(sponsors, row.sponsor) + (row.modification || 0);
    const spent = (row.upgrades || []).reduce((sum, p) => sum + (p != null ? computeUpgradeCost(upgradeParts, p) : 0), 0);
    return {
      driver: driver.driver,
      sponsor: row.sponsor || null,
      budget,
      upgrades: row.upgrades || [],
      modification: row.modification ?? null,
      remainingBudget: budget - spent,
    };
  });

  // ---- ficc backlog proposals: driver-linked rows first (in driver order), then freeform ----
  const driverProposals = driverIds.map((driverId) => {
    const driver = driverById[driverId];
    const p = ficcProposalByDriver[driverId] || {};
    return {
      driverName: driver.driver,
      regulationName: p.regulationName ?? null,
      type: p.type ?? null,
      explanation: p.explanation ?? null,
      expiration: p.expiration ?? null,
    };
  });
  const freeformProposals = (bySeason(itemTypes.FICC_PROPOSAL_FREEFORM, seasonNumber)[0] || {}).items || [];
  const ficcNotesItem = bySeason(itemTypes.FICC_NOTES, seasonNumber)[0] || {};

  return {
    lore: one(itemTypes.LORE) || {},
    drivers: driverItems.map((d) => ({
      player: d.player,
      driver: d.driver,
      teamName: d.teamName,
      carColor: d.carColor,
      backstory: d.backstory,
      username: usernameByDriverId[d.driverId] || null,
    })),
    season: {
      seasonNumber: seasonItem.seasonNumber,
      label: seasonItem.label || String(seasonItem.seasonNumber ?? ""),
      racesThisSeason: seasonItem.racesThisSeason,
      upgradeSlots: seasonItem.upgradeSlots,
      trackSelectionMethod: seasonItem.trackSelectionMethod,
      midSeasonBreakAfterRace: seasonItem.midSeasonBreakAfterRace,
      legends: seasonItem.legends,
      baseTeamBudget: seasonItem.baseTeamBudget,
      schedule: seasonItem.schedule || [],
    },
    // All seasons that exist (for a season switcher) plus which one is
    // "current" (the default/write target) vs. "viewed" (what this
    // response's standings/upgradeTracker/ficcBacklog actually reflect —
    // these differ when someone is just looking at an older season).
    seasons: allSeasonItems.map((s) => ({ seasonNumber: s.seasonNumber, label: s.label || String(s.seasonNumber) })),
    currentSeasonNumber,
    viewedSeasonNumber: seasonNumber,
    technicalRegulations: (one(itemTypes.TECHREGS) || {}).items || [],
    ficcBacklog: {
      notes: ficcNotesItem.notes || [],
      proposals: [...driverProposals, ...freeformProposals],
    },
    standings: { raceLabels, drivers: standingsRows, pointsTable },
    inventory: { upgrades: upgradeParts, sponsors },
    upgradeTracker: { rule: legendItem.rule || "", entries: upgradeEntries, legend: legendItem.legend || [] },
    hallOfFame: {
      seasonLog: (one(itemTypes.HALLOFFAME_SEASONLOG) || {}).items || [],
      missedRaceLog: (one(itemTypes.HALLOFFAME_MISSEDRACELOG) || {}).items || [],
    },
    offSeasonBudget: {
      regulations: (one(itemTypes.OFFSEASON_REGULATIONS) || {}).items || [],
      driverTracker: (one(itemTypes.OFFSEASON_DRIVERTRACKER) || {}).items || [],
      midSeasonWindow: (one(itemTypes.OFFSEASON_MIDSEASONWINDOW) || {}).items || [],
    },
    // Not part of the legacy shape, but useful to the client going
    // forward (e.g. building driver-owner-aware UI) without another round
    // trip — harmless additive field, app.js today simply ignores it.
    driverIds,
    carColors,
  };
}

module.exports = { assembleData, groupByItemType, strip };
