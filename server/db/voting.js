const crypto = require("crypto");
const repo = require("./repo");
const { keys, itemTypes } = require("./keys");
const { buildStandingsRowsForSeason } = require("./ranking");
const { resolveSeason } = require("./currentSeason");

// Assigns a stable id to any item missing one — used for freeform lists
// (technical regulations, freeform FICC proposals) that don't otherwise
// have a natural per-row key, so a vote can be attached to a specific
// item even as the list around it is edited or reordered.
function ensureIds(items) {
  return (items || []).map((item) => (item.id ? item : { ...item, id: crypto.randomUUID() }));
}

// Once a single vote has been cast, this item's content is frozen — the
// thing people are voting on (or already voted on) can't change out from
// under them. Independent of whether it's gone on to resolve; even a
// still-open item with one vote in is locked.
function isContentLocked(item) {
  return Object.keys(item?.votes || {}).length > 0;
}

// For a whole-list replace (freeform FICC proposals, technical
// regulations, both saved as one full array write): finds the id of the
// first item that already has votes cast where either any of `fields`
// changed value, or the item is missing from `newItems` entirely (deleted
// while locked — worse than editing it, since it destroys the record of
// what people voted on). Returns null if nothing locked was touched.
// Callers should reject the whole save on a violation rather than
// silently dropping just that row — simpler and safer than partial
// acceptance.
function findLockedContentViolation(oldItems, newItems, fields) {
  const newById = Object.fromEntries((newItems || []).map((i) => [i.id, i]));
  for (const prev of oldItems || []) {
    if (!isContentLocked(prev)) continue;
    const next = newById[prev.id];
    if (!next) return prev.id;
    if (fields.some((f) => (prev[f] ?? null) !== (next[f] ?? null))) return prev.id;
  }
  return null;
}

// Same whole-list-replace saves must also carry forward each item's
// votes/vetoed/promoted — the client never receives those raw fields (see
// buildVotingView, which strips them down to a derived `voting` view), so
// naively saving whatever array the client sends would silently erase
// everyone's votes on every unrelated edit.
function mergeVotingState(oldItems, newItems) {
  const oldById = Object.fromEntries((oldItems || []).map((i) => [i.id, i]));
  return newItems.map((next) => {
    const prev = oldById[next.id];
    return prev ? { ...next, votes: prev.votes, vetoed: prev.vetoed, promoted: prev.promoted } : next;
  });
}

// The league's written rule is "6/8 votes to pass" — preserved here as a
// fraction (75%) rather than a hardcoded "6" so the threshold still makes
// sense if the roster ever grows or shrinks, while reproducing exactly
// "6" for today's 8 drivers.
const REQUIRED_YES_FRACTION = 0.75;

function requiredYesVotes(driverCount) {
  return Math.ceil(driverCount * REQUIRED_YES_FRACTION);
}

// Resolves the moment the outcome becomes mathematically certain, not
// only once every driver has voted — passes as soon as enough yes votes
// are in, fails as soon as there aren't enough undecided drivers left for
// a yes majority to still be possible. Both conditions naturally cover
// "everyone voted" as a special case, so there's no need to check that
// separately.
function tallyVotes(votes, driverCount) {
  const entries = Object.entries(votes || {});
  const yes = entries.filter(([, v]) => v === "yes").length;
  const no = entries.filter(([, v]) => v === "no").length;
  const votedCount = entries.length;
  const required = requiredYesVotes(driverCount);
  const maxPossibleYes = yes + (driverCount - votedCount);

  let status;
  if (yes >= required) status = "passed";
  else if (maxPossibleYes < required) status = "failed";
  else status = "open";

  return { yes, no, votedCount, required, status };
}

// A vetoed item is always "failed" regardless of its vote tally — the
// champion's Golden Wrench overrides the count outright.
function resolveVotingStatus(item, driverCount) {
  if (item.vetoed) return { ...tallyVotes(item.votes, driverCount), status: "vetoed" };
  return tallyVotes(item.votes, driverCount);
}

// Builds the client-facing view of one votable item's voting state.
// Blind ballot: the yes/no split (and every other driver's individual
// vote) stays hidden from everyone, including admin, until the item
// resolves — only participation count, the viewer's own vote (if any),
// and whether voting is even open at all are visible before that.
function buildVotingView(item, { driverCount, viewerDriverId, votingOpen }) {
  const tally = resolveVotingStatus(item, driverCount);
  const resolved = tally.status !== "open";
  return {
    votingOpen,
    status: tally.status, // "open" | "passed" | "failed" | "vetoed"
    votedCount: tally.votedCount,
    totalVoters: driverCount,
    required: tally.required,
    yes: resolved ? tally.yes : null,
    no: resolved ? tally.no : null,
    myVote: viewerDriverId ? (item.votes || {})[viewerDriverId] || null : null,
  };
}

// Whoever finished P1 in `seasonNumber`'s final standings holds that
// season's one Golden Wrench veto for the off-season that follows it.
// Deterministic and automatic — no manual linking to the Hall of Fame's
// free-text champion name required.
function championDriverId(items, seasonNumber, driverItems) {
  const rows = buildStandingsRowsForSeason(items, seasonNumber, driverItems);
  return rows.find((r) => r.position === 1)?.driverId ?? null;
}

// Turns a passed (and non-vetoed) FICC proposal or tech-reg renewal into
// a technical regulation for the *next* season. Writes directly into that
// season's live regs if it already exists; otherwise parks it on the
// just-ended season's `promotedRegs`, applied automatically whenever that
// next season eventually gets created (see POST /api/season in
// season.routes.js) — so a vote can resolve at any point in the
// off-season regardless of whether the admin has created the next season
// yet. Idempotency (never promoting the same source item twice) is the
// caller's responsibility via that item's own `promoted` flag.
async function promoteToNextSeason(endedSeasonItem, regFields) {
  const promotedReg = { id: crypto.randomUUID(), ...regFields };
  const promotedRegs = [...(endedSeasonItem.promotedRegs || []), promotedReg];
  await repo.updateItem(keys.season(endedSeasonItem.seasonNumber), { promotedRegs });

  const all = await repo.getAll();
  const nextSeasonNumbers = all
    .filter((i) => i.itemType === itemTypes.SEASON && i.seasonNumber > endedSeasonItem.seasonNumber)
    .map((i) => i.seasonNumber);
  const nextSeasonNumber = nextSeasonNumbers.length ? Math.min(...nextSeasonNumbers) : null;
  if (nextSeasonNumber != null) {
    const existingTechRegsItem = await repo.getItem(keys.techRegs(nextSeasonNumber));
    const nextItems = [...(existingTechRegsItem?.items || []), promotedReg];
    await repo.putItem({ ...keys.techRegs(nextSeasonNumber), itemType: itemTypes.TECHREGS, season: nextSeasonNumber, items: nextItems });
  }
}

// Shared vote-casting flow for any votable item (a driver-linked FICC
// proposal, a freeform FICC proposal, or a tech reg) regardless of how
// that item is actually persisted — `persist(attrs)` is a caller-provided
// closure that saves the given attributes back to wherever this
// particular item lives (its own keyed record, or one element inside a
// shared items array). Records the vote, and if it now resolves to
// "passed", promotes it forward and marks it `promoted` in the same save.
async function castVote({ item, seasonItem, voterDriverId, vote, driverCount, toRegFields, persist }) {
  if (resolveVotingStatus(item, driverCount).status !== "open") {
    const err = new Error("This item's vote is already resolved");
    err.status = 400;
    throw err;
  }
  const votes = { ...(item.votes || {}), [voterDriverId]: vote };
  const updatedItem = { ...item, votes };
  const attrs = { votes };
  if (resolveVotingStatus(updatedItem, driverCount).status === "passed") {
    await promoteToNextSeason(seasonItem, toRegFields(updatedItem));
    attrs.promoted = true;
  }
  await persist(attrs);
  return { ...updatedItem, ...attrs };
}

// The champion's one-per-off-season veto: forces this item to fail
// regardless of its tally. Can only be used on a still-open item, and
// only once per off-season — `seasonItem.vetoUsedBy` is the guard,
// checked and set here so two near-simultaneous veto attempts can't both
// succeed.
async function castVeto({ item, seasonItem, championId, driverCount, persist }) {
  if (resolveVotingStatus(item, driverCount).status !== "open") {
    const err = new Error("This item's vote is already resolved");
    err.status = 400;
    throw err;
  }
  if (seasonItem.vetoUsedBy) {
    const err = new Error("The champion's veto has already been used this off-season");
    err.status = 400;
    throw err;
  }
  await persist({ vetoed: true });
  await repo.updateItem(keys.season(seasonItem.seasonNumber), { vetoUsedBy: championId });
  return { ...item, vetoed: true };
}

// Shared precondition check for every vote/veto route (FICC proposals,
// freeform or driver-linked, and tech regs): resolves the season, and
// throws (with an HTTP status attached) if voting isn't actually open for
// it yet. Callers catch and respond with `err.status`/`err.message`, same
// pattern as castVote/castVeto above.
async function loadVotingContext(req) {
  const season = await resolveSeason(req.query.season);
  const seasonItem = await repo.getItem(keys.season(season));
  if (!seasonItem) {
    const err = new Error("No such season");
    err.status = 404;
    throw err;
  }
  if (!seasonItem.ended) {
    const err = new Error("Voting isn't open — this season hasn't ended yet");
    err.status = 400;
    throw err;
  }
  const all = await repo.getAll();
  const driverItems = all.filter((i) => i.itemType === itemTypes.DRIVER);
  return { season, seasonItem, all, driverItems, driverCount: driverItems.length };
}

module.exports = {
  ensureIds,
  requiredYesVotes,
  tallyVotes,
  resolveVotingStatus,
  buildVotingView,
  championDriverId,
  promoteToNextSeason,
  castVote,
  castVeto,
  loadVotingContext,
  isContentLocked,
  findLockedContentViolation,
  mergeVotingState,
};
