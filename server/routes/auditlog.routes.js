const express = require("express");
const repo = require("../db/repo");
const { itemTypes } = require("../db/keys");

const router = express.Router();

// Read-only, admin-only (see server/app.js mount) — entries themselves are
// written directly by server/db/repo.js, not by any route here.
router.get("/", async (req, res) => {
  const all = await repo.getAll();
  const entries = all
    .filter((i) => i.itemType === itemTypes.AUDIT_LOG)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  res.json({ entries });
});

module.exports = router;
