// The Driver Off-Season Tracker and Mid-Season Upgrade Window panels were
// removed from the Off-Season Budget page (deemed unused/useless) along
// with their routes and keys — this deletes whatever data they left
// behind so it doesn't linger as orphaned items in the table.
const OLD_KEYS = [
  { PK: "OFFSEASON#DRIVERTRACKER", SK: "PROFILE" },
  { PK: "OFFSEASON#MIDSEASONWINDOW", SK: "PROFILE" },
];

module.exports = {
  name: "003-drop-offseason-tracker-tables",
  description: "Delete the orphaned Driver Off-Season Tracker and Mid-Season Upgrade Window items.",
  async up(repo) {
    for (const key of OLD_KEYS) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await repo.getItem(key);
      if (!existing) continue;
      // eslint-disable-next-line no-await-in-loop
      await repo.deleteItem(key);
    }
  },
};
