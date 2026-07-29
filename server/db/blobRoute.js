const express = require("express");
const repo = require("./repo");
const { requireAdmin } = require("../auth/middleware");

// Factory for the admin-only "replace this document's fields" routes —
// lore, season, technical regs, the freeform FICC/off-season/hall-of-fame
// lists. Each is edited rarely by one person (the admin) with no natural
// per-row key, so this is simpler than modeling per-row CRUD for them,
// matching the client's existing add/delete-in-place UX.
//
// Deliberately a PARTIAL update (only the fields pickFields returns,
// skipping anything undefined), not a full-item overwrite: a caller that
// sends an incomplete body (a bug, or a future partial-save client) would
// otherwise silently delete every field it didn't mention.
function blobRoute(keyFn, itemType, pickFields) {
  const router = express.Router();
  router.put("/", requireAdmin, async (req, res) => {
    const fields = pickFields(req.body || {});
    const attrs = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No fields provided" });
    const updated = await repo.updateItem(keyFn(), attrs);
    res.json({ ...updated, itemType });
  });
  return router;
}

module.exports = { blobRoute };
