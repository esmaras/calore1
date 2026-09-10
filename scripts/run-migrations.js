// Runs every migration in migrations/ that hasn't already been applied to
// whichever table the current environment points at (DYNAMODB_TABLE /
// DYNAMODB_ENDPOINT — see server/config.js), in filename order. See
// migrations/README.md for the format and why this exists.
const fs = require("fs");
const path = require("path");
const repo = require("../server/db/repo");
const { keys, itemTypes } = require("../server/db/keys");
const config = require("../server/config");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();

  console.log(`Running migrations against table "${config.dynamodbTable}"${config.dynamodbEndpoint ? ` (${config.dynamodbEndpoint})` : ""}...`);

  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    if (migration.name !== file.replace(/\.js$/, "")) {
      throw new Error(`${file}: exported name "${migration.name}" doesn't match filename`);
    }

    // eslint-disable-next-line no-await-in-loop
    const record = await repo.getItem(keys.migration(migration.name));
    if (record) {
      console.log(`  ✓ ${migration.name} — already applied ${record.appliedAt}`);
      continue;
    }

    console.log(`  → ${migration.name} — ${migration.description}`);
    // eslint-disable-next-line no-await-in-loop
    await migration.up(repo);
    // eslint-disable-next-line no-await-in-loop
    await repo.putItem({
      ...keys.migration(migration.name),
      itemType: itemTypes.MIGRATION,
      name: migration.name,
      description: migration.description,
      appliedAt: new Date().toISOString(),
    });
    console.log(`  ✓ ${migration.name} — done`);
  }

  console.log("Up to date.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
