const repo = require("./repo");
const { keys } = require("./keys");

// The stored "current season" pointer — the default view when nobody has
// picked a specific season, and where writes land when a request doesn't
// specify one. Falls back to season 1 only if the pointer itself is
// somehow missing (e.g. a database that predates multi-season support and
// hasn't been backfilled) rather than throwing, since this is read on
// every request.
async function getCurrentSeasonNumber() {
  const pointer = await repo.getItem(keys.currentSeasonPointer());
  return pointer ? pointer.seasonNumber : 1;
}

// Resolves the season a request is acting on: an explicit `?season=`
// query value if present and numeric, otherwise the current-season
// pointer. Deliberately falls back rather than throwing on a malformed
// value — this app has no global Express error-handling middleware, and
// `season` is only ever set by our own client code, never typed by a
// person, so silently treating "invalid" the same as "not specified" is
// safe and avoids needing try/catch at every call site.
async function resolveSeason(querySeason) {
  if (querySeason != null && querySeason !== "") {
    const n = Number(querySeason);
    if (Number.isFinite(n)) return n;
  }
  return getCurrentSeasonNumber();
}

// A season locks Standings, the Upgrade Tracker, Season config/schedule,
// and Tech Regs content the moment it ends — voting and the FICC Backlog
// deliberately stay open through the off-season (see offseasonEndedLock).
function seasonEndedLock(seasonItem) {
  return !!seasonItem?.ended;
}

// The off-season's own close: set by POST /:seasonNumber/close-offseason,
// this is what finally freezes voting and the FICC Backlog for a season.
function offseasonEndedLock(seasonItem) {
  return !!seasonItem?.offseasonEnded;
}

module.exports = { getCurrentSeasonNumber, resolveSeason, seasonEndedLock, offseasonEndedLock };
