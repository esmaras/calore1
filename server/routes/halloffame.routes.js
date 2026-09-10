const express = require("express");
const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");

const router = express.Router();
const itemsOnly = (body) => ({ items: body.items });

// Season-by-season champion log is auto-derived from actual standings
// (see assembleData) — no write route for it, on purpose. Hall of Lame
// stays admin-editable freeform.
router.use("/missed-race-log", blobRoute(keys.hallOfFameMissedRaceLog, itemTypes.HALLOFFAME_MISSEDRACELOG, itemsOnly));

module.exports = router;
