const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes } = require("../db/keys");
const { requireSelfOrAdmin } = require("../auth/middleware");

const router = express.Router();

const EDITABLE_FIELDS = ["player", "driver", "teamName", "backstory"];

// A driver may only ever touch their own record — the route is scoped to
// :driverId and requireSelfOrAdmin checks it, so this isn't just a UI hint.
router.put("/:driverId", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const existing = await repo.getItem(keys.driver(driverId));
  if (!existing) return res.status(404).json({ error: "No such driver" });

  const attrs = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) attrs[field] = req.body[field];
  }
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No editable fields provided" });

  const updated = await repo.updateItem(keys.driver(driverId), attrs);
  res.json(updated);
});

// Car color has a uniqueness constraint enforced atomically via a
// TransactWriteItems: release the driver's old claim (only if it's really
// theirs), atomically claim the new color (conditional on nobody already
// holding it), and update the driver record — all or nothing. A plain
// read-then-write here would allow two drivers to race for the same color.
router.put("/:driverId/car-color", requireSelfOrAdmin("driverId"), async (req, res) => {
  const { driverId } = req.params;
  const { carColor } = req.body || {};
  if (!carColor) return res.status(400).json({ error: "carColor is required" });

  const colorConfig = await repo.getItem(keys.carColorConfig(carColor));
  if (!colorConfig || colorConfig.active === false) {
    return res.status(400).json({ error: `"${carColor}" is not an allowed color` });
  }

  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  if (driver.carColor === carColor) {
    return res.json(driver); // no-op, already this color
  }

  const transactItems = [
    {
      Put: {
        Item: { ...keys.carColorClaim(carColor), itemType: itemTypes.CARCOLORCLAIM, driverId },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        Key: keys.driver(driverId),
        UpdateExpression: "SET #c = :c",
        ExpressionAttributeNames: { "#c": "carColor" },
        ExpressionAttributeValues: { ":c": carColor },
      },
    },
  ];
  if (driver.carColor) {
    transactItems.unshift({
      Delete: {
        Key: keys.carColorClaim(driver.carColor),
        ConditionExpression: "driverId = :self",
        ExpressionAttributeValues: { ":self": driverId },
      },
    });
  }

  try {
    await repo.transactWrite(transactItems);
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return res.status(409).json({ error: `"${carColor}" is already taken by another driver.` });
    }
    throw err;
  }

  res.json({ ...driver, carColor });
});

module.exports = router;
