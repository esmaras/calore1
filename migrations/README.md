# Migrations

One-time data/schema changes that need to run against every environment's
DynamoDB table (local dev **and** production), tracked so each one runs
exactly once no matter how many times the runner is invoked.

This exists because of a real incident: a season-scoping change to
technical regulations was deployed to production without its corresponding
data migration ever being run there (it had only been run against local
DynamoDB Local), which made all existing regulations disappear from the
live site. `make deploy` now runs pending migrations against the target
environment automatically, before the new image goes live.

## Writing a migration

Add a new file here named `NNN-short-description.js` (zero-padded sequence
number, run in filename order). It must export:

```js
module.exports = {
  name: "NNN-short-description",   // must match the filename (sans .js)
  description: "One line explaining what this does and why.",
  async up(repo) {
    // Use repo.getItem/putItem/updateItem/deleteItem/getAll (server/db/repo.js).
    // Must be safe to run against a table that's already in the target
    // shape — check before writing, and no-op if there's nothing to do.
    // The runner only calls this once per environment (see below), but a
    // migration that's also idempotent on its own is much cheaper to
    // reason about if it ever needs to run twice by accident.
  },
};
```

## Running

Local (against DynamoDB Local, via `.env.dev`):

```
npm run db:migrate-schema
```

Against a deployed environment (e.g. production):

```
make migrate ENV=dev   # ENV names the calore1-<ENV>-app table/resources — "dev" is prod, see Makefile
```

`make deploy` runs `make migrate` automatically, after the new image is
pushed but before the App Runner deployment is triggered — so by the time
the new code starts serving traffic, the data is already in the shape it
expects.

## How "already applied" is tracked

The runner writes one `MIGRATION#<name>` item to the table the moment a
migration finishes (see `keys.migration` in `server/db/keys.js`). Its
existence is the only thing checked — the runner skips any migration whose
record it finds, in filename order, and stops there (it does not require
a fully contiguous run — if migration 003 is somehow marked applied but
002 isn't, 002 will still run and 003 will still be skipped).
