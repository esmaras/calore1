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
  // Guests (no session at all) get a lighter-touch player identity — see
  // firstNameOnly in assemble.js. Every OTHER caller of assembleData
  // (internal recomputation, season-end snapshots, admin actions) leaves
  // isAuthenticated at its default `true`, on purpose — those need the
  // real, full data regardless of who's making the request.
  res.json(assembleData(items, season, user?.driverId ?? null, { isAuthenticated: !!user }));
});

module.exports = router;
