const express = require("express");
const repo = require("../db/repo");
const { assembleData } = require("../db/assemble");
const { resolveSeason } = require("../db/currentSeason");

const router = express.Router();

router.get("/", async (req, res) => {
  const items = await repo.getAll();
  const season = await resolveSeason(req.query.season);
  res.json(assembleData(items, season));
});

module.exports = router;
