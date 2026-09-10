// Historical migration: SEASON items originally used `archived` /
// `carryoverByDriver`, later renamed to `ended` / `endedCarryoverByDriver`
// (see server/routes/season.routes.js) to better match what the field
// actually means. Safe no-op on any table that never had the old field
// names (this was true of production by the time this migration was
// written — the rename shipped before any season had been ended there).
const { keys } = require("../server/db/keys");
const { itemTypes } = require("../server/db/keys");

module.exports = {
  name: "002-season-ended-field-rename",
  description: "Rename legacy SEASON.archived/carryoverByDriver fields to ended/endedCarryoverByDriver.",
  async up(repo) {
    const all = await repo.getAll();
    const legacySeasons = all.filter((i) => i.itemType === itemTypes.SEASON && i.archived && !i.ended);
    for (const season of legacySeasons) {
      // eslint-disable-next-line no-await-in-loop
      await repo.updateItem(keys.season(season.seasonNumber), {
        ended: true,
        endedCarryoverByDriver: season.carryoverByDriver || [],
      });
    }
  },
};
