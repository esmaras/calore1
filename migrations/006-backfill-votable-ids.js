// Early TECHREGS/FICC_PROPOSAL_FREEFORM data (seeded from the original
// data.json import, before per-item voting existed) predates ensureIds()
// — the stable `id` a vote is actually keyed on — so any row nobody has
// resaved through PUT /techregs or PUT /ficc/proposals/freeform since ids
// were introduced still has none. Nothing looked wrong until someone tried
// to vote: PUT /techregs/:id/vote (or the freeform equivalent) looks the
// row up by `id`, finds nothing, and 404s ("No such regulation") even
// though the row is sitting right there in the table. Backfills every
// affected row once, table-wide, in every environment (see
// migrations/README.md — this is the same class of bug that motivated
// this migrations system in the first place).
const { keys, itemTypes } = require("../server/db/keys");
const { ensureIds } = require("../server/db/voting");

const KEY_FOR_TYPE = {
  [itemTypes.TECHREGS]: keys.techRegs,
  [itemTypes.FICC_PROPOSAL_FREEFORM]: keys.ficcProposalFreeform,
};

module.exports = {
  name: "006-backfill-votable-ids",
  description: "Backfill missing `id` fields on TECHREGS and FICC_PROPOSAL_FREEFORM items so voting/vetoing can find them.",
  async up(repo) {
    const all = await repo.getAll();
    for (const item of all) {
      const keyFor = KEY_FOR_TYPE[item.itemType];
      if (!keyFor || !Array.isArray(item.items) || item.items.every((i) => i.id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await repo.updateItem(keyFor(item.season), { items: ensureIds(item.items) });
    }
  },
};
