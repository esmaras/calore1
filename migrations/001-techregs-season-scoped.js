// Historical migration, encoding a change already made by hand in
// production during a recovery incident (see migrations/README.md). Kept
// here — rather than deleted now that prod is fixed — so the record of
// what changed is permanent and so this migration system's own tracking
// record for it exists in every environment, not just the one it was
// manually patched in.
const { keys, itemTypes } = require("../server/db/keys");
const { ensureIds } = require("../server/db/voting");

const OLD_KEY = { PK: "TECHREGS#1", SK: "PROFILE" };
const SEASON = 1; // this league's only season when tech regs were first introduced

module.exports = {
  name: "001-techregs-season-scoped",
  description: "Move the old global TECHREGS#1 item into season-scoped TECHREGS/SEASON#<n> storage.",
  async up(repo) {
    const old = await repo.getItem(OLD_KEY);
    if (!old) return; // already migrated, or this environment never had the old shape

    const items = ensureIds(old.items || []);
    await repo.putItem({ ...keys.techRegs(SEASON), itemType: itemTypes.TECHREGS, season: SEASON, items });
    await repo.deleteItem(OLD_KEY);
  },
};
