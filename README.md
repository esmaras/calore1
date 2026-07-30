# Calore 1 — Campaign Tracker

A web app for running a *HEAT: Pedal to the Metal* tabletop racing campaign
with a group of friends: driver roster, race standings, upgrade card
tracking, sponsor/inventory reference, season rules, and league lore —
with real logins and per-driver permissions.

## Stack

- **Server**: Node.js + Express (`server/`), no build step
- **Client**: vanilla JS, no framework/bundler (`public/`)
- **Database**: DynamoDB (single table), via AWS SDK v3 — DynamoDB Local
  for development, real AWS when hosted
- **Auth**: username/password (bcrypt), signed-cookie sessions — no
  external auth service

## Prerequisites

- Node.js 20+ (uses the built-in `--env-file` flag)
- Docker (for DynamoDB Local)

## Running locally

```bash
npm install

# 1. Start DynamoDB Local (runs in-memory — see "Data persistence" below)
npm run dynamodb:up

# 2. Create the table (idempotent, safe to re-run)
npm run db:create-table

# 3. Seed it — only needed once per DynamoDB Local session, since data is
#    in-memory and disappears when the container restarts. Requires an
#    admin password; picks driver passwords automatically.
node --env-file=.env.dev scripts/migrate-to-dynamodb.js --admin-password=<choose-a-password>

# 4. Start the app
npm start
```

Then open **http://localhost:4173**.

The migration script prints every driver's username and a randomly
generated temporary password **once**, to the terminal — copy these down
(or re-run the script) before closing that terminal, they aren't saved
anywhere else. Each driver is forced to set their own password on first
login. The admin username is always `admin`, with whatever password you
passed to `--admin-password`.

### Environment variables

The app loads **`.env.dev`** (via Node's `--env-file` flag, baked into
every `npm run` script) — this is the "dev" environment's config file,
following the same `.env.<environment>` convention the eventual
`Makefile` (Phase 7, not built yet) will drive with an `ENV=` variable.
A working `.env.dev` already exists in this checkout. `.env.example`
documents the variables our code actually reads — copy it to `.env.dev`
if setting up a fresh clone or a new environment file:

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs login session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it logs everyone out. |
| `AWS_REGION` | Read specifically by `server/config.js` — a same-named `AWS_DEFAULT_REGION` (which the AWS CLI/SDK read by convention) does **not** satisfy this. Any value works against DynamoDB Local; must be a real region once pointed at AWS. |
| `DYNAMODB_ENDPOINT` | `http://localhost:8000` for DynamoDB Local. **Unset this to talk to real AWS DynamoDB instead** — that's the only change needed to point the app at production data (the app then falls back to the standard AWS credential chain — `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars, `aws configure`, or an IAM role). |
| `DYNAMODB_TABLE` | Table name (`calore1-app` by default). |
| `PORT` | HTTP port for the app server (`4173` by default). |

`.env.dev` (and any other `.env.*` file, `.env.example` excepted) is
gitignored and never committed — `SESSION_SECRET` and any real AWS
credentials in it are live secrets. **Note:** the `.env.dev` in this
checkout also carries `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` for a
real AWS account, plus a couple of fields (`ALLOWED_ORIGINS`,
`LOG_LEVEL`) left over from another project's template that this app's
code doesn't currently read — harmless as long as `DYNAMODB_ENDPOINT`
stays pointed at DynamoDB Local (see `server/db/client.js`: when that's
set, the app ignores those AWS credentials entirely and uses fake local
ones instead), but worth knowing they're real credentials sitting in a
local file, not something to copy into a shared or committed template.

### Data persistence in local dev

DynamoDB Local runs with `-inMemory` (see `docker-compose.yml`) — all data
is lost when the container stops. This is deliberate (avoids a Docker
volume permission issue on macOS) and fine for iterating on the app, but
means:

- After `docker compose down` / a machine restart, re-run
  `npm run dynamodb:up` then the migration script again to get data back.
- Don't rely on DynamoDB Local as a place to keep real campaign progress
  long-term — that's what real AWS (once hosted) is for.

`data.json` in the repo root is the **pre-migration snapshot** of the
original spreadsheet-derived data — kept as a reference/backup, not read
by the running app anymore. `extract.py` (which builds `data.json` from
the original `.xlsx`) is similarly no longer part of the runtime path.

## Deploying to AWS

Infrastructure is Terraform-managed (`infra/`) and deliberately minimal for
a small app: **ECR** (one image repo), **DynamoDB** (the real table,
same PK/SK shape as local), **IAM** (an access role for App Runner to pull
from ECR, an instance role for the running app scoped to just this table),
and **App Runner** as the container host. No VPC, ALB, or NAT — App Runner
is a fully managed host with its own HTTPS endpoint, and DynamoDB is a
public AWS API, so neither needs one.

**One-time setup:**

```bash
make tf-init                     # once per machine/workspace
make ssm-put-secret               # stores SESSION_SECRET in SSM (prompts, or auto-generates)
make tf-bootstrap                  # creates ECR + DynamoDB + IAM (App Runner not yet — no image pushed)
```

Use `make tf-bootstrap` here, not `make tf-apply` — `tf-apply` (and `tf-plan`) always
pass a concrete `app_image` value for ongoing deploys, so running either of those
before any image has been pushed creates an App Runner service pointing at a
nonexistent image tag, which fails immediately with a `CREATE_FAILED` status
("ECR image doesn't exist"). `tf-bootstrap` passes `app_image=""` explicitly so
App Runner is correctly skipped until `make deploy` pushes a real image.

**First deploy** (and every deploy after):

```bash
make deploy   # build image -> push to ECR -> terraform apply -> trigger App Runner deployment -> print URL
```

The first `make deploy` is what actually brings the App Runner service up
(`infra/main.tf` gates its creation on an image existing in ECR *and* the
SSM secret existing — both are true by the time `make deploy` reaches
`terraform apply`). After that, `make deploy` just ships new code.

Other useful targets: `make logs` (tail the running app's logs), `make url`
(print the deployed URL), `make tf-plan`/`make tf-destroy`. Run `make help`
for the full list. All of these accept `ENV=prod` (default is `dev`) to
target a differently-named environment.

**Populating real data**: the migration script works the same against real
AWS as it does locally — just point `.env.dev` (or a `.env.prod`, if you
set one up) at the real table by removing `DYNAMODB_ENDPOINT`, then run
`make db-create-table` and `make db-migrate ADMIN_PASSWORD=...` against it.
That's the only difference between local and real AWS: which `DYNAMODB_ENDPOINT`
value (or its absence) the app is reading.

## Permissions model

Two roles: **admin** (one login, full access) and **driver** (one login
per driver, tied to a specific driver record via `driverId`). Enforced
server-side on every route, not just hidden in the UI.

| Area | Who can edit |
|---|---|
| A driver's own profile (name, team, backstory, car color) | That driver, or admin |
| Car color | Same as above — plus a uniqueness lock: two drivers can't hold the same color, enforced atomically (see `server/routes/drivers.routes.js`) |
| Race results (Standings) | Admin only |
| Upgrade Tracker (sponsor + upgrade picks) | Admin only |
| A driver's own FICC rule proposal | That driver, or admin |
| Lore & Trophies | Admin only |
| Everything else (Season, Technical Regs, Off-Season Budget, Hall of Fame, Inventory) | Admin only (Inventory is currently read-only for everyone — real CRUD is part of the upcoming admin panel) |

Admin-provisioned accounts only — no self-signup. Reset a driver's
password by re-running the migration script's user-creation step, or
(once built) via the admin panel.

## Project layout

```
server/
  index.js              Creates the HTTP listener (app.listen) — the only difference between running the app and requiring it in a test
  app.js                 The actual Express app: middleware + all route mounts, exported for tests to import directly
  config.js              Env var reader
  db/
    client.js             DynamoDB client (endpoint swappable via .env.dev)
    keys.js                 Single source of truth for item PK/SK formats
    repo.js                   Scan-all + in-memory cache, get/put/update/transact wrappers
    assemble.js                Turns raw DynamoDB items into the JSON shape the client expects; recomputes derived fields (standings totals/positions, upgrade budgets) server-side, always
    blobRoute.js                Shared factory for the "admin replaces one whole document" routes
  auth/
    cookies.js             HMAC-signed session token (sign/verify)
    passwords.js             bcrypt hashing + temp password generation
    middleware.js              requireAuth / requireAdmin / requireSelfOrAdmin
    users.js                    renameUser() — shared by self-service and admin username-change routes
  routes/                 One file per resource (drivers, standings, upgrade-tracker, lore, season, techregs, ficc, offseason, halloffame, auth, admin, data)
scripts/
  create-dynamodb-table.js  Idempotent table creation
  migrate-to-dynamodb.js      One-time seed from data.json + user creation
tests/
  security.test.js          node:test coverage for the highest-risk paths — run with `npm test` or `make test`
public/
  index.html, app.js, style.css   The whole client — no build step
infra/                    Terraform: ECR, DynamoDB, IAM, App Runner (see "Deploying to AWS" above)
Dockerfile, .dockerignore  Single production image, built/pushed by the Makefile
Makefile                  Drives every deploy step (build/push/terraform/deploy/logs) — `make help` for the list
data.json                 Pre-migration snapshot, kept as a backup/reference
extract.py                 Builds data.json from the original .xlsx (not part of the runtime app anymore)
server.js (repo root)      Superseded by server/index.js + server/app.js — the original zero-dependency prototype server, kept only for history; not used by any npm script
```

## Roadmap

Tracked as an in-progress plan — see `/Users/esmaras/.claude/plans/golden-exploring-blum.md`
for full detail on what's done and what's left:

- [x] DynamoDB migration
- [x] Auth (login, sessions, forced password change, self-service + admin username changes)
- [x] Per-resource routes with real RBAC
- [x] Admin panel (car colors CRUD, inventory edits, driver creation, password resets)
- [x] Tests for the highest-risk paths (concurrent car-color claim, cross-driver write rejection, admin-route rejection, username uniqueness)
- [x] Terraform + Makefile for AWS deployment (authored and `terraform plan`-validated against real AWS; no resources have actually been created — that's an explicit `make tf-apply`/`make deploy` away)
- [ ] Upgrade-parts/sponsors "add new" CRUD (editing existing rows works; adding/removing rows doesn't yet)
