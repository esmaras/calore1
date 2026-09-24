const { itemTypes } = require("./keys");
const { buildStandingsRowsForSeason, driversAsOfSeason } = require("./ranking");
const { computeCompliance, computeSponsorCompliance } = require("./priority");
const { buildVotingView, championDriverId, resolveRequiredYes } = require("./voting");

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

// A driver's visual identity — display name, driver number, its badge
// styling (font/shape/color), and car color — lives on their DRIVER
// record, global and never season-scoped, so editing any of it (a
// rename, a new number, a new car color — see PUT /api/drivers/:driverId)
// otherwise retroactively rewrites how they're shown in every past
// season's standings/results/hall of fame/voting record too, which
// misrepresents what actually happened at the time (including a driver
// who had NO number/icon back then suddenly appearing to have always had
// one). Once a season has ended, its own `endedDriverIdentities` snapshot
// (frozen the moment it ended — see POST /:seasonNumber/end) takes
// priority, field by field, over the driver's current live record; a
// season that hasn't ended yet (or ended before this snapshot existed)
// just falls back to the live record, same as before. Returns a lookup
// function rather than a plain map so callers can resolve identities for
// an arbitrary season (e.g. the Hall of Fame's season-by-season log) just
// as easily as for the one currently being viewed.
function driverIdentityResolver(forSeasonItem, driverById) {
  const frozenById =
    forSeasonItem?.ended && Array.isArray(forSeasonItem.endedDriverIdentities)
      ? Object.fromEntries(forSeasonItem.endedDriverIdentities.map((d) => [d.driverId, d]))
      : null;
  return (driverId) => ({ ...driverById[driverId], ...(frozenById?.[driverId] || null) });
}

// The subset of a (possibly frozen) driver record that drives the client's
// number-badge-or-color-dot indicator — pulled out so every season-scoped
// row that shows one (upgrade tracker entries, FICC proposals) carries it
// directly rather than making the client re-derive it via a live lookup,
// which is exactly the lookup that would otherwise defeat the freeze (see
// driverIdentityResolver above).
function driverIndicatorFields(driver) {
  return {
    driverNumber: driver.driverNumber ?? null,
    numberFont: driver.numberFont ?? null,
    numberBgShape: driver.numberBgShape ?? null,
    numberBgColor: driver.numberBgColor ?? null,
    carColor: driver.carColor ?? null,
  };
}

// Turns the flat array of DynamoDB items (as returned by repo.getAll())
// into the same aggregate shape the client (public/app.js) has always
// consumed. Derived fields (standings totalPoints/position, upgrade
// tracker budget/remainingBudget) are computed here every time, never
// read from storage — closes the class of bugs where a stale stored
// value drifts from the fields it's derived from.
//
// A guest (no session at all — see identifyUser in server/auth/middleware.js)
// only gets each driver's first name, not their full player name — the
// driver's own in-game name/persona and backstory stay fully public either
// way; it's specifically the real person behind the wheel that's dialed
// back for a public, unauthenticated audience. Any signed-in viewer
// (driver or admin) still sees everyone's full player name, same as today.
function firstNameOnly(fullName) {
  if (!fullName) return fullName;
  const trimmed = String(fullName).trim();
  return trimmed ? trimmed.split(/\s+/)[0] : fullName;
}

// `viewedSeason` selects which season's Standings/Upgrade Tracker/FICC
// Backlog/Technical Regulations data to assemble — driver roster,
// inventory, lore, hall of fame, and off-season budget are NOT
// season-scoped (they carry over season to season).
function assembleData(items, viewedSeason, viewerDriverId = null, { isAuthenticated = true } = {}) {
  const byType = groupByItemType(items);
  const one = (type) => strip((byType[type] || [])[0]);
  const bySeason = (type, season) => (byType[type] || []).filter((i) => i.season === season);

  // allDriverItems is the full current roster — used only for the Drivers
  // page itself (drivers/inventory aren't season-scoped, so that page
  // always shows everyone regardless of which season is being viewed).
  // Everything else below that's specific to `seasonNumber` (standings,
  // upgrade tracker, FICC Backlog roster, voting participant count) uses
  // `driverItems`, filtered to whoever had actually joined by then — a
  // driver added today must not retroactively appear in (or change the
  // voter count for) an already-ended season. See driversAsOfSeason.
  const allDriverItems = [...(byType[itemTypes.DRIVER] || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const driverById = Object.fromEntries(allDriverItems.map((d) => [d.driverId, d]));

  const allSeasonItems = (byType[itemTypes.SEASON] || []).map(strip).sort((a, b) => a.seasonNumber - b.seasonNumber);
  const currentSeasonNumber = (one(itemTypes.CURRENTSEASON_POINTER) || {}).seasonNumber ?? allSeasonItems[0]?.seasonNumber ?? 1;
  const seasonNumber = viewedSeason ?? currentSeasonNumber;
  const seasonItem = allSeasonItems.find((s) => s.seasonNumber === seasonNumber) || {};

  // Frozen-identity-aware stand-in for driverById, used everywhere a
  // driver's identity (name, number/badge styling, car color, backstory)
  // is displayed as part of THIS season's data (standings, upgrade
  // tracker, FICC proposals, voting reveal, and — via
  // driversForViewedSeason below — the Drivers page's own past-season
  // view). driverById itself stays live/unmodified for the one place
  // that deliberately always wants the current identity regardless of
  // viewed season: the Drivers page's CURRENT-season view (the `drivers`
  // field below, always the full live roster).
  const identityForViewedSeason = driverIdentityResolver(seasonItem, driverById);
  const effectiveDriverById = Object.fromEntries(allDriverItems.map((d) => [d.driverId, identityForViewedSeason(d.driverId)]));

  const driverItems = driversAsOfSeason(allDriverItems, seasonNumber).map((d) => effectiveDriverById[d.driverId]);
  const driverIds = driverItems.map((d) => d.driverId);

  const pointsTable = seasonItem.pointsTable || [];
  // Derived from the schedule, not stored separately — otherwise adding or
  // editing a race in Season & Schedule would silently drift out of sync
  // with the headers Standings/Race Results actually show (see
  // buildStandingsRowsForSeason in ranking.js, which sizes each driver's
  // races the same way).
  const raceLabels = (seasonItem.schedule || []).map((r) => (r.track ? `Race ${r.race}: ${r.track}` : `Race ${r.race}`));

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

  // ---- off-season winnings & upgrade-swap allowance: one row per
  // POSITION (1..driverCount), not per driver — these are configured
  // against a finishing position before (or while) the season is still
  // being decided, so the row itself must stay stable no matter how
  // standings shift afterward. Building this by mapping over driverItems
  // instead (as earlier versions did) meant a tie — the default state of
  // every position before any race has a result — collapsed multiple
  // drivers onto the same position and showed them duplicate rows with
  // identical values, and any standings change reshuffled which driver a
  // value visually sat next to. `projectedDrivers` is the ONLY thing tied
  // to current standings here — purely informational (rendered as
  // "Current Projection" on the Off-Season Budget page), never the row's
  // identity or something a save touches.
  const positionSlots = Array.from({ length: driverIds.length }, (_, i) => {
    const position = i + 1;
    return { position, projectedDrivers: standingsRows.filter((r) => r.position === position).map((r) => r.driver) };
  });
  const winningsValueByPosition = Object.fromEntries(
    bySeason(itemTypes.OFFSEASON_WINNINGS, seasonNumber).map((w) => [w.position, w.winnings ?? null])
  );
  const winningsTable = positionSlots.map((slot) => ({ ...slot, winnings: winningsValueByPosition[slot.position] ?? null }));
  const swapAllowanceValueByPosition = Object.fromEntries(
    bySeason(itemTypes.OFFSEASON_SWAPLIMIT, seasonNumber).map((w) => [w.position, w.maxSwaps ?? null])
  );
  const swapAllowanceTable = positionSlots.map((slot) => ({ ...slot, maxSwaps: swapAllowanceValueByPosition[slot.position] ?? null }));

  // Driver-keyed shape kept separately, ONLY for computeCarryoverByDriver
  // (above, via a recursive assembleData call on the prior season) and
  // POST /:seasonNumber/end — both need "how much does THIS driver's
  // current position pay," which only makes sense resolved per-driver.
  // Not meant for display — see winningsTable for that.
  const winningsByDriver = [...standingsRows]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({ driverId: row.driverId, driver: row.driver, position: row.position, winnings: winningsValueByPosition[row.position] ?? null }));

  // ---- upgrade tracker ----
  const legendItem = one(itemTypes.UPGRADETRACKER_LEGEND) || {};
  const carryoverByDriverId = computeCarryoverByDriver(items, seasonNumber, allSeasonItems);
  const upgradeEntries = driverIds.map((driverId) => {
    const driver = effectiveDriverById[driverId];
    const row = upgradeTrackerByDriver[driverId] || { sponsor: null, upgrades: [], modification: 0 };
    const carryover = carryoverByDriverId[driverId] || 0;
    const budget = (seasonItem.baseTeamBudget || 0) + sponsorFunding(sponsors, row.sponsor) + (row.modification || 0) + carryover;
    const spent = (row.upgrades || []).reduce((sum, p) => sum + (p != null ? computeUpgradeCost(upgradeParts, p) : 0), 0);
    // swapAllowance/carryoverUpgrades are frozen onto this row the moment
    // the season was created (see createNextSeason in season.routes.js) —
    // not recomputed live, since they're a snapshot of a fact from the
    // PRIOR season (what this driver held, and what position they
    // finished in) rather than something derived from current data.
    // swapsUsed IS recomputed live, same as everything else here: how many
    // of those carried-over parts are no longer in the current picks.
    const swapAllowance = row.swapAllowance ?? null;
    const swapsUsed = Array.isArray(row.carryoverUpgrades)
      ? row.carryoverUpgrades.filter((p) => p != null && !(row.upgrades || []).includes(p)).length
      : 0;
    return {
      driverId,
      driver: driver.driver,
      ...driverIndicatorFields(driver),
      sponsor: row.sponsor || null,
      budget,
      carryover,
      upgrades: row.upgrades || [],
      modification: row.modification ?? null,
      remainingBudget: budget - spent,
      swapAllowance,
      swapsUsed,
      // Exposed so computeCompliance (below) can tell a retained carryover
      // part from a freshly-claimed one — see its own comment for why that
      // distinction matters for priority.
      carryoverUpgrades: Array.isArray(row.carryoverUpgrades) ? row.carryoverUpgrades : null,
    };
  });

  // A driver's row is "out of compliance" when a higher-priority driver
  // (see server/db/priority.js — priority comes from the previous season's
  // final standings) has since claimed a part this driver is also holding,
  // pushing total claims for that part past its countAvailable, or has
  // since claimed the same sponsor (which only ever has room for one —
  // see computeSponsorCompliance, whose priority order is deliberately the
  // reverse of the parts one above). Neither is ever stored — recomputed
  // fresh every read, same as budget above — so a row can flip on its own
  // as other drivers make their picks.
  const complianceIssuesByDriver = computeCompliance(items, seasonNumber, driverItems, upgradeEntries, upgradeParts);
  const sponsorIssuesByDriver = computeSponsorCompliance(items, seasonNumber, driverItems, upgradeEntries);
  for (const entry of upgradeEntries) {
    const issues = [...(complianceIssuesByDriver.get(entry.driverId) || []), ...(sponsorIssuesByDriver.get(entry.driverId) || [])];
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
  // proposals and expiring regs, not the prior one. Blind ballot while
  // open: the yes/no split and everyone else's individual vote stay
  // hidden from every viewer (including admin) until an item resolves,
  // at which point the full ballot is revealed to everyone — except a
  // driver who hasn't voted yet, who still sees it (and can still vote)
  // as open until they do — see buildVotingView in server/db/voting.js.
  const driverCount = driverIds.length;
  const votingOpen = !!seasonItem.ended && !seasonItem.offseasonEnded;
  // FICC proposals and tech-reg renewals are separately configurable (see
  // resolveRequiredYes in voting.js) — a season admin may want a
  // different pass bar for one than the other.
  const ficcRequiredYes = resolveRequiredYes(seasonItem, "ficcRequiredYesVotes", driverCount);
  const techRegsRequiredYes = resolveRequiredYes(seasonItem, "techRegsRequiredYesVotes", driverCount);
  const ficcVotingCtx = { driverCount, requiredYes: ficcRequiredYes, viewerDriverId, votingOpen, driverById: effectiveDriverById };
  const techRegsVotingCtx = { driverCount, requiredYes: techRegsRequiredYes, viewerDriverId, votingOpen, driverById: effectiveDriverById };
  // Whoever finished P1 this season holds its one Golden Wrench veto for
  // the resulting off-season — exposed so the client can show the veto
  // button only to that driver (and admin), and only while it's unused.
  const seasonChampionDriverId = championDriverId(items, seasonNumber, driverItems);

  const driverProposals = driverIds.map((driverId) => {
    const driver = effectiveDriverById[driverId];
    const p = ficcProposalByDriver[driverId] || {};
    return {
      driverId,
      driverName: driver.driver,
      ...driverIndicatorFields(driver),
      regulationName: p.regulationName ?? null,
      explanation: p.explanation ?? null,
      voting: buildVotingView(p, ficcVotingCtx),
    };
  });
  const freeformProposals = ((bySeason(itemTypes.FICC_PROPOSAL_FREEFORM, seasonNumber)[0] || {}).items || []).map((p) => {
    const { votes: _votes, vetoed: _vetoed, promoted: _promoted, ...rest } = p;
    return { ...rest, voting: buildVotingView(p, ficcVotingCtx) };
  });
  const ficcNotesItem = bySeason(itemTypes.FICC_NOTES, seasonNumber)[0] || {};
  const techRegsItem = bySeason(itemTypes.TECHREGS, seasonNumber)[0] || {};

  return {
    lore: one(itemTypes.LORE) || {},
    // driverId included directly (unlike historically) so the client can
    // key off it reliably — this array is the full, unfiltered, always-
    // live roster (see the comment on allDriverItems above), a different
    // length/order than the season-scoped driverIds the client used to
    // (mis)reuse for index-matching against this one.
    drivers: allDriverItems.map((d) => ({
      driverId: d.driverId,
      player: isAuthenticated ? d.player : firstNameOnly(d.player),
      driver: d.driver,
      teamName: d.teamName,
      carColor: d.carColor,
      backstory: d.backstory,
      username: usernameByDriverId[d.driverId] || null,
      driverNumber: d.driverNumber ?? null,
      numberFont: d.numberFont ?? null,
      numberBgShape: d.numberBgShape ?? null,
      numberBgColor: d.numberBgColor ?? null,
    })),
    // Same shape as `drivers` above, but resolved for THIS season
    // specifically — every field frozen where the viewed season has a
    // snapshot for it, live otherwise (see driverIdentityResolver). This
    // is a single source of truth for "what did this driver look like
    // during this season," so a client view (the Drivers page's
    // past-season display) never has to reconstruct that itself field by
    // field — that reconstruction is exactly how the team-name field
    // went missing from one client code path while working in another.
    driversForViewedSeason: driverIds.map((id) => ({
      driverId: id,
      player: isAuthenticated ? effectiveDriverById[id].player : firstNameOnly(effectiveDriverById[id].player),
      driver: effectiveDriverById[id].driver,
      teamName: effectiveDriverById[id].teamName,
      carColor: effectiveDriverById[id].carColor,
      backstory: effectiveDriverById[id].backstory,
      username: usernameByDriverId[id] || null,
      driverNumber: effectiveDriverById[id].driverNumber ?? null,
      numberFont: effectiveDriverById[id].numberFont ?? null,
      numberBgShape: effectiveDriverById[id].numberBgShape ?? null,
      numberBgColor: effectiveDriverById[id].numberBgColor ?? null,
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
      offseasonEnded: seasonItem.offseasonEnded || false,
      championDriverId: seasonChampionDriverId,
      vetoUsedBy: seasonItem.vetoUsedBy || null,
      // The admin's raw override (null = "use the default 75% formula"),
      // plus what that actually resolves to right now given today's
      // eligible driver count — so the settings UI can show a real number
      // even while the field itself is blank/unset. See resolveRequiredYes.
      ficcRequiredYesVotes: seasonItem.ficcRequiredYesVotes ?? null,
      ficcRequiredYesVotesEffective: ficcRequiredYes,
      techRegsRequiredYesVotes: seasonItem.techRegsRequiredYesVotes ?? null,
      techRegsRequiredYesVotesEffective: techRegsRequiredYes,
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
      return { ...rest, voting: buildVotingView(r, techRegsVotingCtx) };
    }),
    ficcBacklog: {
      notes: ficcNotesItem.notes || "",
      proposals: [...driverProposals, ...freeformProposals],
    },
    standings: { raceLabels, drivers: standingsRows, pointsTable },
    inventory: { upgrades: upgradePartsWithAvailability, sponsors },
    upgradeTracker: { rule: legendItem.rule || "", entries: upgradeEntries, legend: legendItem.legend || [] },
    hallOfFame: {
      // Auto-populated, not admin-typed: one row per season that's
      // actually been ended, with the champion (and their team, standing
      // in for "constructor" — this league is one driver per team) read
      // straight from that season's own final standings. A season that
      // hasn't ended yet has no business showing a "champion" — nothing
      // is final until End Season says so. Each season resolves the
      // champion's identity against its OWN endedDriverIdentities
      // snapshot (not the viewed season's) — this log spans every ended
      // season at once, so a driver's name here must reflect whichever
      // season each row is actually about.
      seasonLog: allSeasonItems
        .filter((s) => s.ended)
        .map((s) => {
          const champId = championDriverId(items, s.seasonNumber, driversAsOfSeason(allDriverItems, s.seasonNumber));
          const identityForThatSeason = driverIdentityResolver(s, driverById);
          const champIdentity = champId ? identityForThatSeason(champId) : null;
          return {
            season: s.seasonNumber,
            champion: champIdentity?.driver ?? null,
            // teamName isn't part of the freeze-on-end snapshot by default
            // (see POST /:seasonNumber/end) — but driverIdentityResolver's
            // merge is generic, so a manually-added override (an ad-hoc
            // production fix for one driver/season, say) still takes
            // effect here the same way a frozen name does.
            constructorChampion: champIdentity?.teamName ?? null,
          };
        }),
      missedRaceLog: (one(itemTypes.HALLOFFAME_MISSEDRACELOG) || {}).items || [],
    },
    offSeasonBudget: {
      regulations: (one(itemTypes.OFFSEASON_REGULATIONS) || {}).items || [],
      // winningsByDriver is NOT for display (see its own comment above) —
      // the client renders winningsTable/swapAllowanceTable instead.
      winningsByDriver,
      winningsTable,
      swapAllowanceTable,
    },
    // Not part of the legacy shape, but useful to the client going
    // forward (e.g. building driver-owner-aware UI) without another round
    // trip — harmless additive field, app.js today simply ignores it.
    driverIds,
    carColors,
  };
}

module.exports = { assembleData, groupByItemType, strip };
