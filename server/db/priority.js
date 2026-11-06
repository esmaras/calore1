const { itemTypes } = require("./keys");
const { buildStandingsRowsForSeason } = require("./ranking");
const { computeSeasonPhase, midwayReached } = require("./midSeason");

// A driver's upgrade-pick priority for `seasonNumber` is based on standing
// — but *whose* standing depends on how far into the season we are.
// Until this season reaches its mid-season break, that's the previous
// season's final standings (the largest existing season number below this
// one). From the break on, it's this season's standings through the break
// race (see the comment inside the function). Worse standing (bigger
// position number) picks first.
// A driver who didn't exist yet as of the basis season (joined after it —
// i.e. a brand-new driver added for a new season) has no standing to base
// anything on at all, so they always rank lowest priority, for upgrades
// *and* sponsors alike, regardless of `reversed` — a new driver shouldn't
// vault to the front of the upgrade queue just because "no history" would
// otherwise sort like "last place." (A driver who already existed as of
// the basis season but simply scored zero points there is a real last
// place, not a missing history, and is ranked by that position as normal.)
// With no basis season at all (nothing before this one exists yet),
// everyone ties and roster order (DRIVER.order) breaks it.
// `reversed` flips who picks first among drivers who DO have a real basis:
// false (the default, used for upgrade parts) gives worse-standing
// drivers first pick, same as a fantasy-league draft. true (used for
// sponsors — see computeSponsorCompliance) gives first place first pick
// instead — the opposite fairness call, since a sponsor is closer to a
// reward for winning than a handicap-balancing mechanic.
function computePriorityOrder(items, seasonNumber, driverItems, { reversed = false } = {}) {
  // Once this season reaches its mid-season break (see
  // server/db/midSeason.js), priority comes from this season's standings
  // as they stood through the break race — frozen, so later races can't
  // reshuffle who wins a mid-season conflict. Before that (including the
  // locked stretch after race 1, when picks can't change anyway) it stays
  // on the prior season's final standings, same as at season start.
  const phaseInfo = computeSeasonPhase(items, seasonNumber);
  let basisSeasonNumber = null;
  let throughRace = null;
  if (midwayReached(phaseInfo.phase)) {
    basisSeasonNumber = seasonNumber;
    throughRace = phaseInfo.midwayRace;
  } else {
    const priorSeasonNumbers = items
      .filter((i) => i.itemType === itemTypes.SEASON && i.seasonNumber < seasonNumber)
      .map((i) => i.seasonNumber);
    basisSeasonNumber = priorSeasonNumbers.length ? Math.max(...priorSeasonNumbers) : null;
  }

  const rosterOrderById = Object.fromEntries(driverItems.map((d, i) => [d.driverId, d.order ?? i]));
  const positionById = {};
  if (basisSeasonNumber != null) {
    for (const row of buildStandingsRowsForSeason(items, basisSeasonNumber, driverItems, { throughRace })) {
      positionById[row.driverId] = row.position;
    }
  }
  const noBasisById = Object.fromEntries(
    driverItems.map((d) => [d.driverId, basisSeasonNumber == null || (d.joinedSeason ?? -Infinity) > basisSeasonNumber])
  );

  const ordered = [...driverItems].sort((a, b) => {
    const noBasisA = noBasisById[a.driverId];
    const noBasisB = noBasisById[b.driverId];
    if (noBasisA !== noBasisB) return noBasisA ? 1 : -1; // no basis-season standing at all always ranks lowest, either way
    const posA = positionById[a.driverId] ?? 0;
    const posB = positionById[b.driverId] ?? 0;
    if (posA !== posB) return reversed ? posA - posB : posB - posA; // bigger (worse) position picks first, unless reversed
    return (rosterOrderById[a.driverId] ?? 0) - (rosterOrderById[b.driverId] ?? 0);
  });

  const priorityRank = new Map();
  ordered.forEach((d, i) => priorityRank.set(d.driverId, i)); // 0 = highest priority
  return priorityRank;
}

// claims: [{ driverId, isNew }] for one part. A driver *retaining* a part
// they carried over from last season (isNew: false — see carryoverUpgrades
// on each computeCompliance entry) always outranks any fresh claim on that
// same part, regardless of upgrade-pick priority: a kept part was never
// actually returned to the shared pool, so there's nothing for a
// higher-priority driver to legitimately take — only a part someone
// actually swapped away becomes available to claim by priority. Ties
// among claims of the same kind (two retained, or two fresh) still
// resolve by priority as before.
function rankClaimsByPriority(claims, priorityRank) {
  return [...claims].sort((a, b) => {
    if (!!a.isNew !== !!b.isNew) return a.isNew ? 1 : -1;
    return (priorityRank.get(a.driverId) ?? Infinity) - (priorityRank.get(b.driverId) ?? Infinity);
  });
}

// Claims on each upgrade part: [{ driverId, isNew }]. A part still in
// this driver's "retained" set was never given up, so it's exempt from
// being bumped by a higher-priority claim (see rankClaimsByPriority).
// Before the mid-season break that set is carryoverUpgrades (what they
// finished last season holding). From the break on, it's what they held
// going into the window: midSeasonBaseline, or the current picks if they
// never touched their row during it. Anything else (a brand-new driver's
// picks, a swap-in) is a fresh claim.
function buildPartClaims(upgradeEntries, atMidway) {
  const claimsByPart = {};
  for (const entry of upgradeEntries) {
    const retainedSource = atMidway ? (entry.midSeasonBaseline ?? entry.upgrades) : entry.carryoverUpgrades;
    const retained = new Set(retainedSource || []);
    for (const p of entry.upgrades || []) {
      if (p == null) continue;
      (claimsByPart[p] ||= []).push({ driverId: entry.driverId, isNew: !retained.has(p) });
    }
  }
  return claimsByPart;
}

// Same idea for sponsors. Before the break nobody retains a sponsor (a new
// season starts with none, so it's pure priority). From the break on, a
// team keeping the sponsor it held going into the window retains it, so a
// better-placed team can't take it at the mid-season swap.
function buildSponsorClaims(upgradeEntries, atMidway) {
  const claimsBySponsor = {};
  for (const entry of upgradeEntries) {
    if (!entry.sponsor) continue;
    const retained = atMidway && entry.midSeasonBaselineSponsor === entry.sponsor;
    (claimsBySponsor[entry.sponsor] ||= []).push({ driverId: entry.driverId, isNew: !retained });
  }
  return claimsBySponsor;
}

// How many OTHER claims rank ahead of `driverId` making a fresh claim:
// every retained claim, plus every fresh claim from a higher-priority
// driver. Lower-priority fresh claims don't count, since this driver
// would bump them.
function claimsAhead(claims, driverId, priorityRank) {
  const myRank = priorityRank.get(driverId) ?? Infinity;
  return (claims || []).filter((c) => c.driverId !== driverId && (!c.isNew || (priorityRank.get(c.driverId) ?? Infinity) < myRank)).length;
}

// Mid-season window only: for each driver, the parts and sponsors they
// can't newly pick right now because the claims ahead of them already fill
// every copy. Unlike the compliance flags (which only flag after the fact),
// these are enforced as hard blocks by the Upgrade Tracker route and greyed
// out in the dropdowns. Outside the window this is empty: end-of-season
// picks keep the flag-only behaviour.
function computeBlockedPicks(items, seasonNumber, driverItems, upgradeEntries, upgradeParts) {
  const result = new Map();
  if (computeSeasonPhase(items, seasonNumber).phase !== "midseasonWindow") return result;
  const partRank = computePriorityOrder(items, seasonNumber, driverItems);
  const sponsorRank = computePriorityOrder(items, seasonNumber, driverItems, { reversed: true });
  const partClaims = buildPartClaims(upgradeEntries, true);
  const sponsorClaims = buildSponsorClaims(upgradeEntries, true);
  for (const entry of upgradeEntries) {
    const parts = upgradeParts
      .filter((u) => claimsAhead(partClaims[u.partNumber], entry.driverId, partRank) >= (u.countAvailable || 0))
      .map((u) => u.partNumber);
    const sponsors = Object.keys(sponsorClaims).filter((name) => claimsAhead(sponsorClaims[name], entry.driverId, sponsorRank) >= 1);
    result.set(entry.driverId, { parts, sponsors });
  }
  return result;
}

// For every upgrade part, ranks all of this season's current claims by
// priority and flags any claim beyond the part's countAvailable as
// non-compliant. Never mutates/removes anything — this is purely a
// read-time derived view, recomputed fresh every call (same house style
// as budget/availableCount elsewhere), so a driver's row can flip to
// non-compliant later without anyone's stored pick ever changing.
function computeCompliance(items, seasonNumber, driverItems, upgradeEntries, upgradeParts) {
  const priorityRank = computePriorityOrder(items, seasonNumber, driverItems);
  const countAvailableByPart = Object.fromEntries(upgradeParts.map((u) => [u.partNumber, u.countAvailable || 0]));
  const partTypeByNumber = Object.fromEntries(upgradeParts.map((u) => [u.partNumber, u.type]));

  const atMidway = midwayReached(computeSeasonPhase(items, seasonNumber).phase);
  const claimsByPart = buildPartClaims(upgradeEntries, atMidway);

  const issuesByDriver = new Map();
  for (const [partNumberStr, claims] of Object.entries(claimsByPart)) {
    const partNumber = Number(partNumberStr);
    const total = countAvailableByPart[partNumber] || 0;
    const ranked = rankClaimsByPriority(claims, priorityRank);
    ranked.forEach((claim, idx) => {
      if (idx < total) return; // within capacity — compliant
      // idx alone conflates two different reasons a claim gets bumped: a
      // genuinely higher-priority fresh claim, or a retained claim ahead
      // of it (which always sorts first regardless of priority — see
      // rankClaimsByPriority). Split them so the client can say which one
      // actually happened, instead of always blaming "higher priority"
      // even when every claim ahead of this one is a lower-priority
      // driver simply retaining a part they never gave up.
      const aheadClaims = ranked.slice(0, idx);
      const retainedCount = aheadClaims.filter((c) => !c.isNew).length;
      const higherPriorityCount = aheadClaims.length - retainedCount;
      const list = issuesByDriver.get(claim.driverId) || [];
      list.push({ partNumber, partType: partTypeByNumber[partNumber], higherPriorityCount, retainedCount });
      issuesByDriver.set(claim.driverId, list);
    });
  }
  return issuesByDriver;
}

// A sponsor has an implicit capacity of exactly 1 — no two drivers may
// hold the same one — ranked by priority the same way an oversubscribed
// upgrade part is, except reversed (see computePriorityOrder): first
// place gets first pick of sponsors, since this is closer to a reward for
// winning than a handicap-balancing mechanic. Same "never blocks the
// save, just flags it" house style as computeCompliance above — a driver
// picking a sponsor someone with better priority already holds saves
// fine and shows up non-compliant until one of them changes their pick.
function computeSponsorCompliance(items, seasonNumber, driverItems, upgradeEntries) {
  const priorityRank = computePriorityOrder(items, seasonNumber, driverItems, { reversed: true });

  const atMidway = midwayReached(computeSeasonPhase(items, seasonNumber).phase);
  const claimsBySponsor = buildSponsorClaims(upgradeEntries, atMidway);

  const issuesByDriver = new Map();
  for (const [sponsor, claims] of Object.entries(claimsBySponsor)) {
    const ranked = rankClaimsByPriority(claims, priorityRank);
    ranked.forEach((claim, idx) => {
      if (idx < 1) return; // one exclusive holder — everyone else conflicts
      const list = issuesByDriver.get(claim.driverId) || [];
      // Ahead of this claim is either a team retaining the sponsor from
      // before the mid-season break, or a higher-priority claim.
      const ahead = ranked.slice(0, idx);
      const retainedCount = ahead.filter((c) => !c.isNew).length;
      list.push({ sponsor, higherPriorityCount: ahead.length - retainedCount, retainedCount });
      issuesByDriver.set(claim.driverId, list);
    });
  }
  return issuesByDriver;
}

module.exports = { computePriorityOrder, rankClaimsByPriority, computeCompliance, computeSponsorCompliance, computeBlockedPicks };
