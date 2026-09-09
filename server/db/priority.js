const { itemTypes } = require("./keys");
const { buildStandingsRowsForSeason } = require("./ranking");

// A driver's upgrade-pick priority for `seasonNumber` is based on standing
// — but *whose* standing depends on how far into the season we are.
// Before any race in `seasonNumber` has a result recorded, there's nothing
// to prioritize off yet, so it falls back to the previous season's final
// standings (the largest existing season number below this one — seasons
// are always sequential, but this avoids assuming seasonNumber - 1
// specifically exists). Once a race in `seasonNumber` has happened,
// priority switches to that season's own live standings instead — drivers
// can change upgrade parts mid-season, and that mid-season swap should be
// prioritized by how the season is actually going right now, not by
// whatever happened last year. Worse standing (bigger position number)
// picks first. A driver with no rows in whichever season is the basis
// (brand new, or hasn't raced yet this season) gets zero points/no races
// run through the same ranking, which naturally lands them at or near the
// bottom — i.e. top priority — with no special-casing needed. With
// nothing to base priority on at all, everyone ties and roster order
// (DRIVER.order) breaks it.
function computePriorityOrder(items, seasonNumber, driverItems) {
  const currentSeasonHasResults = items.some(
    (i) => i.itemType === itemTypes.STANDINGS && i.season === seasonNumber && (i.races || []).some((r) => r != null)
  );

  let basisSeasonNumber = null;
  if (currentSeasonHasResults) {
    basisSeasonNumber = seasonNumber;
  } else {
    const priorSeasonNumbers = items
      .filter((i) => i.itemType === itemTypes.SEASON && i.seasonNumber < seasonNumber)
      .map((i) => i.seasonNumber);
    basisSeasonNumber = priorSeasonNumbers.length ? Math.max(...priorSeasonNumbers) : null;
  }

  const rosterOrderById = Object.fromEntries(driverItems.map((d, i) => [d.driverId, d.order ?? i]));
  const positionById = {};
  if (basisSeasonNumber != null) {
    for (const row of buildStandingsRowsForSeason(items, basisSeasonNumber, driverItems)) {
      positionById[row.driverId] = row.position;
    }
  }

  const ordered = [...driverItems].sort((a, b) => {
    const posA = positionById[a.driverId] ?? 0;
    const posB = positionById[b.driverId] ?? 0;
    if (posA !== posB) return posB - posA; // bigger (worse) position picks first
    return (rosterOrderById[a.driverId] ?? 0) - (rosterOrderById[b.driverId] ?? 0);
  });

  const priorityRank = new Map();
  ordered.forEach((d, i) => priorityRank.set(d.driverId, i)); // 0 = highest priority
  return priorityRank;
}

// claims: [{ driverId, isNew }] for one part. Existing claims should be
// listed before any new claim so a stable sort resolves priority ties in
// favor of whoever already holds the part.
function rankClaimsByPriority(claims, priorityRank) {
  return [...claims].sort((a, b) => (priorityRank.get(a.driverId) ?? Infinity) - (priorityRank.get(b.driverId) ?? Infinity));
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

  const claimsByPart = {};
  for (const entry of upgradeEntries) {
    for (const p of entry.upgrades || []) {
      if (p == null) continue;
      (claimsByPart[p] ||= []).push({ driverId: entry.driverId, isNew: false });
    }
  }

  const issuesByDriver = new Map();
  for (const [partNumberStr, claims] of Object.entries(claimsByPart)) {
    const partNumber = Number(partNumberStr);
    const total = countAvailableByPart[partNumber] || 0;
    rankClaimsByPriority(claims, priorityRank).forEach((claim, idx) => {
      if (idx < total) return; // within capacity — compliant
      const list = issuesByDriver.get(claim.driverId) || [];
      list.push({ partNumber, partType: partTypeByNumber[partNumber], higherPriorityCount: idx });
      issuesByDriver.set(claim.driverId, list);
    });
  }
  return issuesByDriver;
}

module.exports = { computePriorityOrder, rankClaimsByPriority, computeCompliance };
