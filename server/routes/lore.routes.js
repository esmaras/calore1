const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");

module.exports = blobRoute(keys.lore, itemTypes.LORE, (body) => ({
  leagueName: body.leagueName,
  governingBody: body.governingBody,
  founded: body.founded,
  motto: body.motto,
  driversTrophy: body.driversTrophy,
  constructorsTrophy: body.constructorsTrophy,
  backstoryNote: body.backstoryNote,
}));
