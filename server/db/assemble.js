const { itemTypes } = require("./keys");
const { buildStandingsRowsForSeason } = require("./ranking");
const { computeCompliance } = require("./priority");
const { buildVotingView, championDriverId } = require("./voting");

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

// Each driver's starting budget for `seasonNumber` includes a rollover
// from the prior season (its final remainingBudget + that driver's
// off-season winnings). While the prior season is still open, this is
// computed live — recursing into assembleData for that season — so
// creating the next season early still tracks whatever's currently true.
// Once the prior season has ended (POST /:seasonNumber/end), its
// endedCarryoverByDriver snapshot is used directly instead: a fixed,
// stored number that never needs recomputing again (until /reopen clears
// it, putting this season back on the live-computed path).
function computeCarryoverByDriver(items, seasonNumber, allSeasonItems) {
  const priorSeasonNumbers = allSeasonItems.filter((s) => s.seasonNumber < seasonNumber).map((s) => s.seasonNumber);
  const priorSeasonNumber = priorSeasonNumbers.length ? Math.max(...priorSeasonNumbers) : null;
  if (priorSeasonNumber == null) return {};

  const priorSeasonItem = allSeasonItems.find((s) => s.seasonNumber === priorSeasonNumber);
  if (priorSeasonItem?.ended && Array.isArray(priorSeasonItem.endedCarryoverByDriver)) {
    return Object.fromEntries(priorSeasonItem.endedCarryoverByDriver.map((c) => [c.driverId, c.carryover || 0]));
  }

  const prior = assembleData(items, priorSeasonNumber);
  const priorWinningsByDriverId = Object.fromEntries(prior.offSeasonBudget.winningsByDriver.map((w) => [w.driverId, w.winnings || 0]));
  return Object.fromEntries(
    prior.upgradeTracker.entries.map((e) => [e.driverId, (e.remainingBudget || 0) + (priorWinningsByDriverId[e.driverId] || 0)])
  );
}

// Turns the flat array of DynamoDB items (as returned by repo.getAll())
// into the same aggregate shape the client (public/app.js) has always
// consumed. Derived fields (standings totalPoints/position, upgrade
// tracker budget/remainingBudget) are computed here every time, never
// read from storage — closes the class of bugs where a stale stored
// value drifts from the fields it's derived from.
//
// `viewedSeason` selects which season's Standings/Upgrade Tracker/FICC
// Backlog/Technical Regulations data to assemble — driver roster,
// inventory, lore, hall of fame, and off-season budget are NOT
// season-scoped (they carry over season to season).
function assembleData(items, viewedSeason, viewerDriverId = null) {
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

  const upgradeParts = (byType[itemTypes.UPGRADEPART] || []).map(strip).sort((a, b) => a.partNumber - b.partNumber);
  const sponsors = (byType[itemTypes.SPONSOR] || []).map(strip);
  const carColors = (byType[itemTypes.CARCOLORCONFIG] || [])
    .map(strip)
    .filter((c) => c.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  const upgradeTrackerByDriver = Object.fromEntries(bySeason(itemTypes.UPGRADETRACKER, seasonNumber).map((u) => [u.driverId, u]));
  const ficcProposalByDriver = Object.fromEntries(bySeason(itemTypes.FICC_PROPOSAL, seasonNumber).map((p) => [p.driverId, p]));
  const usernameByDriverId = Object.fromEntries(
    (byType[itemTypes.USER] || []).filter((u) => u.role === "driver" && u.driverId).map((u) => [u.driverId, u.username])
  );

  // ---- standings ----
  const standingsRows = buildStandingsRowsForSeason(items, seasonNumber, driverItems);

  // ---- off-season winnings: one deterministic row per driver, ordered by
  // this season's final standing (not a freeform admin-typed list), so
  // it's unambiguous who gets what — and so the next season's creation
  // (see POST /api/season in season.routes.js) can read it directly to
  // seed each driver's starting budget carryover.
  const winningsByDriverId = Object.fromEntries(
    bySeason(itemTypes.OFFSEASON_WINNINGS, seasonNumber).map((w) => [w.driverId, w.winnings ?? null])
  );
  const winningsByDriver = [...standingsRows]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({ driverId: row.driverId, driver: row.driver, position: row.position, winnings: winningsByDriverId[row.driverId] ?? null }));

  // ---- upgrade tracker ----
  const legendItem = one(itemTypes.UPGRADETRACKER_LEGEND) || {};
  const carryoverByDriverId = computeCarryoverByDriver(items, seasonNumber, allSeasonItems);
  const upgradeEntries = driverIds.map((driverId) => {
    const driver = driverById[driverId];
    const row = upgradeTrackerByDriver[driverId] || { sponsor: null, upgrades: [], modification: 0 };
    const carryover = carryoverByDriverId[driverId] || 0;
    const budget = (seasonItem.baseTeamBudget || 0) + sponsorFunding(sponsors, row.sponsor) + (row.modification || 0) + carryover;
    const spent = (row.upgrades || []).reduce((sum, p) => sum + (p != null ? computeUpgradeCost(upgradeParts, p) : 0), 0);
    return {
      driverId,
      driver: driver.driver,
      sponsor: row.sponsor || null,
      budget,
      carryover,
      upgrades: row.upgrades || [],
      modification: row.modification ?? null,
      remainingBudget: budget - spent,
    };
  });

  // A driver's row is "out of compliance" when a higher-priority driver
  // (see server/db/priority.js — priority comes from the previous season's
  // final standings) has since claimed a part this driver is also holding,
  // pushing total claims for that part past its countAvailable. This is
  // never stored — recomputed fresh every read, same as budget above —
  // so it can flip on its own as other drivers make their picks.
  const complianceIssuesByDriver = computeCompliance(items, seasonNumber, driverItems, upgradeEntries, upgradeParts);
  for (const entry of upgradeEntries) {
    const issues = complianceIssuesByDriver.get(entry.driverId) || [];
    entry.outOfCompliance = issues.length > 0;
    entry.complianceIssues = issues;
  }

  // Inventory's "available count" isn't stored — it's the admin-set stock
  // total minus however many of that part are currently assigned across
  // this season's Upgrade Tracker, so a driver picking a part immediately
  // (and automatically) lowers what everyone else sees as available.
  const usedCountByPart = {};
  for (const entry of upgradeEntries) {
    for (const p of entry.upgrades) {
      if (p != null) usedCountByPart[p] = (usedCountByPart[p] || 0) + 1;
    }
  }
  const upgradePartsWithAvailability = upgradeParts.map((u) => ({
    ...u,
    availableCount: Math.max(0, (u.countAvailable || 0) - (usedCountByPart[u.partNumber] || 0)),
  }));

  // ---- ficc backlog proposals: driver-linked rows first (in driver order), then freeform ----
  // Voting only opens once this season has ended (see season.routes.js
  // /:seasonNumber/end) — the off-season vote is on THIS season's
  // proposals and expiring regs, not the prior one. Blind ballot: the
  // yes/no split and everyone else's individual vote stay hidden from
  // every viewer (including admin) until an item resolves — see
  // buildVotingView in server/db/voting.js.
  const driverCount = driverIds.length;
  const votingOpen = !!seasonItem.ended;
  const votingCtx = { driverCount, viewerDriverId, votingOpen };
  // Whoever finished P1 this season holds its one Golden Wrench veto for
  // the resulting off-season — exposed so the client can show the veto
  // button only to that driver (and admin), and only while it's unused.
  const seasonChampionDriverId = championDriverId(items, seasonNumber, driverItems);

  const driverProposals = driverIds.map((driverId) => {
    const driver = driverById[driverId];
    const p = ficcProposalByDriver[driverId] || {};
    return {
      driverId,
      driverName: driver.driver,
      regulationName: p.regulationName ?? null,
      type: p.type ?? null,
      explanation: p.explanation ?? null,
      expiration: p.expiration ?? null,
      voting: buildVotingView(p, votingCtx),
    };
  });
  const freeformProposals = ((bySeason(itemTypes.FICC_PROPOSAL_FREEFORM, seasonNumber)[0] || {}).items || []).map((p) => {
    const { votes: _votes, vetoed: _vetoed, promoted: _promoted, ...rest } = p;
    return { ...rest, voting: buildVotingView(p, votingCtx) };
  });
  const ficcNotesItem = bySeason(itemTypes.FICC_NOTES, seasonNumber)[0] || {};
  const techRegsItem = bySeason(itemTypes.TECHREGS, seasonNumber)[0] || {};

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
      allowedTiers: seasonItem.allowedTiers || [],
      disallowedTypes: seasonItem.disallowedTypes || [],
      ended: seasonItem.ended || false,
      championDriverId: seasonChampionDriverId,
      vetoUsedBy: seasonItem.vetoUsedBy || null,
    },
    // All seasons that exist (for a season switcher) plus which one is
    // "current" (the default/write target) vs. "viewed" (what this
    // response's standings/upgradeTracker/ficcBacklog actually reflect —
    // these differ when someone is just looking at an older season).
    seasons: allSeasonItems.map((s) => ({ seasonNumber: s.seasonNumber, label: s.label || String(s.seasonNumber) })),
    currentSeasonNumber,
    viewedSeasonNumber: seasonNumber,
    technicalRegulations: (techRegsItem.items || []).map((r) => {
      const { votes: _votes, vetoed: _vetoed, promoted: _promoted, ...rest } = r;
      return { ...rest, voting: buildVotingView(r, votingCtx) };
    }),
    ficcBacklog: {
      notes: ficcNotesItem.notes || [],
      proposals: [...driverProposals, ...freeformProposals],
    },
    standings: { raceLabels, drivers: standingsRows, pointsTable },
    inventory: { upgrades: upgradePartsWithAvailability, sponsors },
    upgradeTracker: { rule: legendItem.rule || "", entries: upgradeEntries, legend: legendItem.legend || [] },
    hallOfFame: {
      seasonLog: (one(itemTypes.HALLOFFAME_SEASONLOG) || {}).items || [],
      missedRaceLog: (one(itemTypes.HALLOFFAME_MISSEDRACELOG) || {}).items || [],
    },
    offSeasonBudget: {
      regulations: (one(itemTypes.OFFSEASON_REGULATIONS) || {}).items || [],
      driverTracker: (one(itemTypes.OFFSEASON_DRIVERTRACKER) || {}).items || [],
      midSeasonWindow: (one(itemTypes.OFFSEASON_MIDSEASONWINDOW) || {}).items || [],
      winningsByDriver,
    },
    // Not part of the legacy shape, but useful to the client going
    // forward (e.g. building driver-owner-aware UI) without another round
    // trip — harmless additive field, app.js today simply ignores it.
    driverIds,
    carColors,
  };
}

module.exports = { assembleData, groupByItemType, strip };
