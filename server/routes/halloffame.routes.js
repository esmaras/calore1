const express = require("express");
const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");

const router = express.Router();
const itemsOnly = (body) => ({ items: body.items });

router.use("/season-log", blobRoute(keys.hallOfFameSeasonLog, itemTypes.HALLOFFAME_SEASONLOG, itemsOnly));
router.use("/missed-race-log", blobRoute(keys.hallOfFameMissedRaceLog, itemTypes.HALLOFFAME_MISSEDRACELOG, itemsOnly));

module.exports = router;
