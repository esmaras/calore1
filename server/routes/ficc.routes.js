const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireSelfOrAdmin, requireAdmin } = require("../auth/middleware");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();

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
  if (!Array.isArray(notes)) return res.status(400).json({ error: "notes must be an array" });
  const season = await resolveSeason(req.query.season);
  const item = { ...keys.ficcNotes(season), itemType: itemTypes.FICC_NOTES, season, notes };
  await repo.putItem(item);
  res.json(item);
});

// Must be registered before /proposals/:driverId below — Express matches
// in registration order, and "freeform" would otherwise satisfy the
// :driverId pattern and shadow this route entirely.
router.put("/proposals/freeform", requireAdmin, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const season = await resolveSeason(req.query.season);
  const item = { ...keys.ficcProposalFreeform(season), itemType: itemTypes.FICC_PROPOSAL_FREEFORM, season, items };
  await repo.putItem(item);
  res.json(item);
});

// "Propose your own regulation" is a personal action — driver-owned, same
// as their Drivers-tab record.
router.put("/proposals/:driverId", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  const season = await resolveSeason(req.query.season);
  const { regulationName, type, explanation, expiration } = req.body || {};
  const item = {
    ...keys.ficcProposal(driverId, season),
    itemType: itemTypes.FICC_PROPOSAL,
    driverId,
    season,
    regulationName: regulationName ?? null,
    type: type ?? null,
    explanation: explanation ?? null,
    expiration: expiration ?? null,
  };
  await repo.putItem(item);
  res.json(item);
});

module.exports = router;
