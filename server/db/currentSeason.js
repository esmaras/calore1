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

// Where a driver joining or leaving the roster right now actually lands.
// Ordinarily that's just the current-season pointer — but advancing the
// pointer (POST /:seasonNumber/set-current) is a deliberately separate,
// manual admin action from ending a season, so the pointer can easily
// still be sitting on a season that has already ended (mid off-season,
// before the admin has gotten around to "Set as current season" for
// whatever's next). That season's roster/standings are locked (see
// seasonEndedLock) but its off-season voting may still be open, and
// driversAsOfSeason (server/db/ranking.js) is what gates who counts
// toward that vote's "N of M" — so a driver added/retired during that
// window must land on the first season that HASN'T ended yet, never
// retroactively join or leave one whose vote tally is already final.
// Loops (not just +1) to also cover back-to-back ended seasons whose
// pointer was never advanced at all. Falls back to the plain pointer
// whenever it isn't sitting on an ended season (including when the
// pointed-to season doesn't exist yet).
async function getRosterChangeSeasonNumber() {
  let candidate = await getCurrentSeasonNumber();
  // eslint-disable-next-line no-await-in-loop
  while ((await repo.getItem(keys.season(candidate)))?.ended) candidate++;
  return candidate;
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

module.exports = { getCurrentSeasonNumber, getRosterChangeSeasonNumber, resolveSeason, seasonEndedLock, offseasonEndedLock };
