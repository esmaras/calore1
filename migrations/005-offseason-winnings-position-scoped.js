// OFFSEASON_WINNINGS items used to be keyed by driverId, so a payout
// stayed attached to whichever driver held a position when the amount was
// entered — if a standings correction later moved someone else into that
// position, the money didn't follow. Re-keys every existing item by the
// driver's position in that season's final standings instead (see
// keys.offSeasonWinnings and assembleData's winningsByDriver in
// server/db/assemble.js). Safe to run on a table that's already migrated
// (every remaining item has `driverId`, none have `position`) or one that
// never had any winnings set at all (no-op).
const { keys, itemTypes } = require("../server/db/keys");
const { buildStandingsRowsForSeason } = require("../server/db/ranking");

module.exports = {
  name: "005-offseason-winnings-position-scoped",
  description: "Re-key OFFSEASON_WINNINGS items from driverId to that driver's position in the season's final standings.",
  async up(repo) {
    const all = await repo.getAll();
    const legacyWinnings = all.filter((i) => i.itemType === itemTypes.OFFSEASON_WINNINGS && i.driverId && i.position == null);
    if (!legacyWinnings.length) return;

    const driverItems = all.filter((i) => i.itemType === itemTypes.DRIVER);

    for (const old of legacyWinnings) {
      const standingsRows = buildStandingsRowsForSeason(all, old.season, driverItems);
      const row = standingsRows.find((r) => r.driverId === old.driverId);
      // eslint-disable-next-line no-await-in-loop
      await repo.deleteItem({ PK: old.PK, SK: old.SK });
      if (!row) continue; // driver no longer exists — nothing to carry forward
      // eslint-disable-next-line no-await-in-loop
      await repo.putItem({
        ...keys.offSeasonWinnings(row.position, old.season),
        itemType: itemTypes.OFFSEASON_WINNINGS,
        position: row.position,
        season: old.season,
        winnings: old.winnings,
      });
    }
  },
};
