const repo = require("../db/repo");
const { keys } = require("../db/keys");

// Username is the DynamoDB PK for USER items, so renaming means moving the
// item to a new key — done as one transaction (delete old + conditional put
// new) so we never end up with zero or two accounts for the same login.
// Shared by the self-service route (a user renaming themselves) and the
// admin route (renaming any user) — same invariant either way: usernames
// are globally unique and independent of driverId (a person's login name
// doesn't have to match their driver's name).
async function renameUser(oldUsername, newUsername) {
  const existing = await repo.getItem(keys.user(oldUsername));
  if (!existing) {
    const err = new Error("No such user");
    err.status = 404;
    throw err;
  }
  if (newUsername === oldUsername) return existing;

  const newItem = { ...existing, ...keys.user(newUsername), username: newUsername };
  try {
    await repo.transactWrite([
      {
        Delete: {
          Key: keys.user(oldUsername),
          ConditionExpression: "username = :u",
          ExpressionAttributeValues: { ":u": oldUsername },
        },
      },
      { Put: { Item: newItem, ConditionExpression: "attribute_not_exists(PK)" } },
    ]);
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      const conflictErr = new Error(`Username "${newUsername}" is already taken.`);
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }
  return newItem;
}

module.exports = { renameUser };
