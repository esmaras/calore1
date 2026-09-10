const express = require("express");
const repo = require("../db/repo");
const { assembleData } = require("../db/assemble");
const { resolveSeason } = require("../db/currentSeason");
const { identifyUser } = require("../auth/middleware");

const router = express.Router();

router.get("/", async (req, res) => {
  const items = await repo.getAll();
  const season = await resolveSeason(req.query.season);
  // This route stays public for guests — identifyUser just quietly
  // recognizes a logged-in driver, if there is one, so assembleData can
  // reveal that driver's own FICC/tech-reg vote without exposing anyone
  // else's (blind ballot — see buildVotingView in server/db/voting.js).
  const user = identifyUser(req);
  res.json(assembleData(items, season, user?.driverId ?? null));
});

module.exports = router;
