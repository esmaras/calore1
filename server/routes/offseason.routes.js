const express = require("express");
const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");

const router = express.Router();
const itemsOnly = (body) => ({ items: body.items });

router.use("/regulations", blobRoute(keys.offSeasonRegulations, itemTypes.OFFSEASON_REGULATIONS, itemsOnly));
router.use("/driver-tracker", blobRoute(keys.offSeasonDriverTracker, itemTypes.OFFSEASON_DRIVERTRACKER, itemsOnly));
router.use("/mid-season-window", blobRoute(keys.offSeasonMidSeasonWindow, itemTypes.OFFSEASON_MIDSEASONWINDOW, itemsOnly));

module.exports = router;
