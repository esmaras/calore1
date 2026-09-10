const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireSelfOrAdmin, requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");
const { castVote, castVeto, championDriverId, loadVotingContext, ensureIds, isContentLocked, findLockedContentViolation, mergeVotingState } = require("../db/voting");

const PROPOSAL_CONTENT_FIELDS = ["regulationName", "explanation", "driverName"];

const router = express.Router();

// A driver votes as themselves (via their own session); admin can vote on
// behalf of any driver but must say which one — there's no session
// driverId to default to. Shared by both proposal-vote routes below.
function resolveVoterDriverId(req) {
  return req.user.role === "admin" ? req.body?.voterDriverId : req.user.driverId;
}

function regFieldsFromProposal(p) {
  return { name: p.regulationName, explanation: p.explanation };
}

// Notes and the freeform proposal list are season-scoped now (a rules
// backlog is naturally per-season), so they can't use the generic
// blobRoute factory — that only knows a fixed key, not "look up the
// season for this request first".
// putItem (full item), not a partial updateItem: these are simple
// single-field documents, and a full write guarantees itemType/season are
// always present even the first time a brand-new season's item is
// created (a partial update on a not-yet-existing item would create it
// with only the fields named in the update expression, silently missing
// itemType/season and breaking assemble.js's group-by-itemType logic).
router.put("/notes", requireAdmin, async (req, res) => {
  const { notes } = req.body || {};
  if (typeof notes !== "string") return res.status(400).json({ error: "notes must be a string" });
  const season = await resolveSeason(req.query.season);
  const item = { ...keys.ficcNotes(season), itemType: itemTypes.FICC_NOTES, season, notes };
  await repo.putItem(item);
  res.json(item);
});

// Must be registered before /proposals/:driverId below — Express matches
// in registration order, and "freeform" would otherwise satisfy the
// :driverId pattern and shadow this route entirely.
//
// A whole-array replace, but votes/vetoed/promoted live on these same
// items and the client never sees those raw fields (see buildVotingView),
// so they have to be carried forward by id rather than just trusting
// whatever the client sends — otherwise any edit to any row would erase
// every proposal's votes. Once a proposal has at least one vote cast, its
// content is frozen (see isContentLocked) — the whole save is rejected if
// it tries to change a locked row, rather than silently dropping just
// that change.
router.put("/proposals/freeform", requireAdmin, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const season = await resolveSeason(req.query.season);

  const existing = await repo.getItem(keys.ficcProposalFreeform(season));
  const existingItems = existing?.items || [];
  const withIds = ensureIds(items);

  const violation = findLockedContentViolation(existingItems, withIds, PROPOSAL_CONTENT_FIELDS);
  if (violation) return res.status(400).json({ error: "A proposal with votes already cast can't have its content changed" });

  const item = {
    ...keys.ficcProposalFreeform(season),
    itemType: itemTypes.FICC_PROPOSAL_FREEFORM,
    season,
    items: mergeVotingState(existingItems, withIds),
  };
  await repo.putItem(item);
  res.json(item);
});

// "Propose your own regulation" is a personal action — driver-owned, same
// as their Drivers-tab record. A partial update (not a full-item put) so
// this never has to touch votes/vetoed/promoted at all — those just stay
// whatever they already were. Locked (see isContentLocked) once a vote's
// been cast, same rule as the freeform list above.
router.put("/proposals/:driverId", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  const season = await resolveSeason(req.query.season);
  const existing = await repo.getItem(keys.ficcProposal(driverId, season));
  if (existing && isContentLocked(existing)) {
    return res.status(400).json({ error: "This proposal already has votes cast — its content is locked" });
  }

  const { regulationName, explanation } = req.body || {};
  const updated = await repo.updateItem(keys.ficcProposal(driverId, season), {
    itemType: itemTypes.FICC_PROPOSAL,
    driverId,
    season,
    regulationName: regulationName ?? null,
    explanation: explanation ?? null,
  });
  res.json(updated);
});

// Must be registered before /proposals/:driverId/vote below, for the same
// "freeform would satisfy :driverId" reason as the routes above — except
// here the segment counts already differ (4 vs 3), so Express wouldn't
// actually confuse them regardless of order; kept adjacent for clarity.
router.put("/proposals/freeform/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { vote } = req.body || {};
  if (vote !== "yes" && vote !== "no") return res.status(400).json({ error: "vote must be 'yes' or 'no'" });
  const voterDriverId = resolveVoterDriverId(req);
  if (!voterDriverId) return res.status(400).json({ error: "voterDriverId is required" });

  try {
    const ctx = await loadVotingContext(req);
    if (!ctx.driverItems.some((d) => d.driverId === voterDriverId)) return res.status(404).json({ error: "No such voter" });

    const freeformItem = await repo.getItem(keys.ficcProposalFreeform(ctx.season));
    const items = freeformItem?.items || [];
    const idx = items.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ error: "No such proposal" });

    const updated = await castVote({
      item: items[idx],
      seasonItem: ctx.seasonItem,
      voterDriverId,
      vote,
      driverCount: ctx.driverCount,
      toRegFields: regFieldsFromProposal,
      persist: async (attrs) => {
        const newItems = [...items];
        newItems[idx] = { ...newItems[idx], ...attrs };
        await repo.updateItem(keys.ficcProposalFreeform(ctx.season), { items: newItems });
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/proposals/freeform/:id/veto", async (req, res) => {
  const { id } = req.params;
  try {
    const ctx = await loadVotingContext(req);
    const champId = championDriverId(ctx.all, ctx.season, ctx.driverItems);
    if (req.user.role !== "admin" && req.user.driverId !== champId) {
      return res.status(403).json({ error: "Only the season champion can veto" });
    }

    const freeformItem = await repo.getItem(keys.ficcProposalFreeform(ctx.season));
    const items = freeformItem?.items || [];
    const idx = items.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ error: "No such proposal" });

    const updated = await castVeto({
      item: items[idx],
      seasonItem: ctx.seasonItem,
      championId: champId,
      driverCount: ctx.driverCount,
      persist: async (attrs) => {
        const newItems = [...items];
        newItems[idx] = { ...newItems[idx], ...attrs };
        await repo.updateItem(keys.ficcProposalFreeform(ctx.season), { items: newItems });
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put("/proposals/:driverId/vote", async (req, res) => {
  const { driverId } = req.params;
  const { vote } = req.body || {};
  if (vote !== "yes" && vote !== "no") return res.status(400).json({ error: "vote must be 'yes' or 'no'" });
  const voterDriverId = resolveVoterDriverId(req);
  if (!voterDriverId) return res.status(400).json({ error: "voterDriverId is required" });

  try {
    const ctx = await loadVotingContext(req);
    if (!ctx.driverItems.some((d) => d.driverId === voterDriverId)) return res.status(404).json({ error: "No such voter" });

    const proposalItem = await repo.getItem(keys.ficcProposal(driverId, ctx.season));
    if (!proposalItem) return res.status(404).json({ error: "No such proposal" });

    const updated = await castVote({
      item: proposalItem,
      seasonItem: ctx.seasonItem,
      voterDriverId,
      vote,
      driverCount: ctx.driverCount,
      toRegFields: regFieldsFromProposal,
      persist: (attrs) => repo.updateItem(keys.ficcProposal(driverId, ctx.season), attrs),
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/proposals/:driverId/veto", async (req, res) => {
  const { driverId } = req.params;
  try {
    const ctx = await loadVotingContext(req);
    const champId = championDriverId(ctx.all, ctx.season, ctx.driverItems);
    if (req.user.role !== "admin" && req.user.driverId !== champId) {
      return res.status(403).json({ error: "Only the season champion can veto" });
    }

    const proposalItem = await repo.getItem(keys.ficcProposal(driverId, ctx.season));
    if (!proposalItem) return res.status(404).json({ error: "No such proposal" });

    const updated = await castVeto({
      item: proposalItem,
      seasonItem: ctx.seasonItem,
      championId: champId,
      driverCount: ctx.driverCount,
      persist: (attrs) => repo.updateItem(keys.ficcProposal(driverId, ctx.season), attrs),
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
