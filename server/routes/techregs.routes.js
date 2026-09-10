const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");
const { ensureIds, castVote, castVeto, championDriverId, loadVotingContext, isContentLocked, findLockedContentViolation, mergeVotingState } = require("../db/voting");

const router = express.Router();

const REG_CONTENT_FIELDS = ["name", "explanation"];

// Season-scoped (see keys.techRegs) — a whole-array replace. Every item
// gets a stable id (backfilled here if missing) so a vote can be attached
// to a specific regulation even as the list is edited or reordered.
// votes/vetoed/promoted live on these same items but the client never
// sees those raw fields (see buildVotingView) — they're carried forward
// by id here rather than trusted from the request, otherwise any edit to
// any row would erase every regulation's votes. Once a regulation has at
// least one vote cast, its content is frozen (see isContentLocked) — the
// whole save is rejected if it tries to change a locked row.
router.put("/", requireAdmin, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const season = await resolveSeason(req.query.season);

  const existing = await repo.getItem(keys.techRegs(season));
  const existingItems = existing?.items || [];
  const withIds = ensureIds(items);

  const violation = findLockedContentViolation(existingItems, withIds, REG_CONTENT_FIELDS);
  if (violation) return res.status(400).json({ error: "A regulation with votes already cast can't have its content changed" });

  const item = { ...keys.techRegs(season), itemType: itemTypes.TECHREGS, season, items: mergeVotingState(existingItems, withIds) };
  await repo.putItem(item);
  res.json(item);
});

function resolveVoterDriverId(req) {
  return req.user.role === "admin" ? req.body?.voterDriverId : req.user.driverId;
}

function regFieldsFromReg(r) {
  return { name: r.name, explanation: r.explanation };
}

// A driver votes on whether an *expiring* regulation gets renewed for
// next season — a "yes" majority (see server/db/voting.js) carries it
// forward automatically via promoteToNextSeason.
router.put("/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { vote } = req.body || {};
  if (vote !== "yes" && vote !== "no") return res.status(400).json({ error: "vote must be 'yes' or 'no'" });
  const voterDriverId = resolveVoterDriverId(req);
  if (!voterDriverId) return res.status(400).json({ error: "voterDriverId is required" });

  try {
    const ctx = await loadVotingContext(req);
    if (!ctx.driverItems.some((d) => d.driverId === voterDriverId)) return res.status(404).json({ error: "No such voter" });

    const techRegsItem = await repo.getItem(keys.techRegs(ctx.season));
    const items = techRegsItem?.items || [];
    const idx = items.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: "No such regulation" });

    const updated = await castVote({
      item: items[idx],
      seasonItem: ctx.seasonItem,
      voterDriverId,
      vote,
      driverCount: ctx.driverCount,
      toRegFields: regFieldsFromReg,
      persist: async (attrs) => {
        const newItems = [...items];
        newItems[idx] = { ...newItems[idx], ...attrs };
        await repo.updateItem(keys.techRegs(ctx.season), { items: newItems });
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/:id/veto", async (req, res) => {
  const { id } = req.params;
  try {
    const ctx = await loadVotingContext(req);
    const champId = championDriverId(ctx.all, ctx.season, ctx.driverItems);
    if (req.user.role !== "admin" && req.user.driverId !== champId) {
      return res.status(403).json({ error: "Only the season champion can veto" });
    }

    const techRegsItem = await repo.getItem(keys.techRegs(ctx.season));
    const items = techRegsItem?.items || [];
    const idx = items.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: "No such regulation" });

    const updated = await castVeto({
      item: items[idx],
      seasonItem: ctx.seasonItem,
      championId: champId,
      driverCount: ctx.driverCount,
      persist: async (attrs) => {
        const newItems = [...items];
        newItems[idx] = { ...newItems[idx], ...attrs };
        await repo.updateItem(keys.techRegs(ctx.season), { items: newItems });
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
