const { blobRoute } = require("../db/blobRoute");
const { keys, itemTypes } = require("../db/keys");

module.exports = blobRoute(keys.techRegs, itemTypes.TECHREGS, (body) => ({ items: body.items }));
