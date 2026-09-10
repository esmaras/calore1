// FICC_NOTES items used to hold `notes` as an array of strings (one per
// text box on the FICC Backlog page); the page now shows a single box, so
// the field is a single string. Joins any existing array into one string,
// separated the way the boxes visually were (a blank line between each).
const { keys, itemTypes } = require("../server/db/keys");

module.exports = {
  name: "004-ficc-notes-single-string",
  description: "Merge FICC_NOTES.notes from an array of strings into one joined string.",
  async up(repo) {
    const all = await repo.getAll();
    const legacyNoteItems = all.filter((i) => i.itemType === itemTypes.FICC_NOTES && Array.isArray(i.notes));
    for (const item of legacyNoteItems) {
      // eslint-disable-next-line no-await-in-loop
      await repo.updateItem(keys.ficcNotes(item.season), { notes: item.notes.join("\n\n") });
    }
  },
};
