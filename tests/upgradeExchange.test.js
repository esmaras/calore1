// In-season upgrade exchange: race-1 lock, mid-season break swap window,
// bottom-X eligibility, funding and priority. See server/db/midSeason.js.
//
// No DynamoDB needed: the pure logic is tested on in-memory item lists,
// and the upgrade-tracker route runs against an in-memory stub of the repo
// module (its methods are looked up per call, so swapping them works),
// mounted with a fake req.user instead of a real login.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const repo = require("../server/db/repo");
const { keys, itemTypes } = require("../server/db/keys");
const { midwayRace, computeSeasonPhase, computeMidSeasonEligible } = require("../server/db/midSeason");
const { assembleData } = require("../server/db/assemble");
const { computePriorityOrder } = require("../server/db/priority");

const SEASON = 1;
const DRIVER_IDS = ["d1", "d2", "d3", "d4", "d5", "d6"];

function schedule(n) {
  return Array.from({ length: n }, (_, i) => ({ race: i + 1, track: `T${i + 1}` }));
}

function baseItems({ races = 8, seasonExtra = {} } = {}) {
  const items = [
    { ...keys.season(SEASON), itemType: itemTypes.SEASON, seasonNumber: SEASON, label: "Test", schedule: schedule(races), baseTeamBudget: 10000000,
      pointsTable: [9, 6, 4, 3, 2, 1].map((points, i) => ({ position: i + 1, points })), ...seasonExtra },
    { ...keys.currentSeasonPointer(), itemType: itemTypes.CURRENTSEASON_POINTER, seasonNumber: SEASON },
  ];
  DRIVER_IDS.forEach((driverId, i) => {
    items.push({ ...keys.driver(driverId), itemType: itemTypes.DRIVER, driverId, order: i, driver: `Driver ${driverId}`, player: "P", teamName: "T" });
  });
  for (let p = 1; p <= 14; p++) {
    items.push({ ...keys.upgradePart(p), itemType: itemTypes.UPGRADEPART, partNumber: p, type: `Type${p}`, cost: 100000, countAvailable: 1 });
  }
  return items;
}

// Every driver finishes in roster order (d1 wins, d6 last) in races 1..n,
// except `overrides`: { raceIdx: [order of driverIds] }.
function postResults(items, n, overrides = {}) {
  const racesByDriver = Object.fromEntries(DRIVER_IDS.map((d) => [d, []]));
  for (let r = 0; r < n; r++) {
    const order = overrides[r] || DRIVER_IDS;
    order.forEach((d, pos) => { racesByDriver[d][r] = pos + 1; });
  }
  const rest = items.filter((i) => i.itemType !== itemTypes.STANDINGS);
  return [...rest, ...DRIVER_IDS.map((d) => ({ ...keys.standings(d, SEASON), itemType: itemTypes.STANDINGS, driverId: d, season: SEASON, races: racesByDriver[d] }))];
}

function drivers(items) {
  return items.filter((i) => i.itemType === itemTypes.DRIVER).sort((a, b) => a.order - b.order);
}

// ---------- pure logic ----------

test("midway race: half the schedule rounded up, admin setting wins when valid", () => {
  assert.equal(midwayRace({ schedule: schedule(8) }), 4);
  assert.equal(midwayRace({ schedule: schedule(7) }), 4);
  assert.equal(midwayRace({ schedule: schedule(1) }), null);
  assert.equal(midwayRace({ schedule: schedule(8), midSeasonBreakAfterRace: 3 }), 3);
  // Out of range (schedule shrank) falls back to the auto value.
  assert.equal(midwayRace({ schedule: schedule(4), midSeasonBreakAfterRace: 6 }), 2);
});

test("phase moves preseason -> locked -> window -> post as results are posted", () => {
  let items = baseItems();
  assert.equal(computeSeasonPhase(items, SEASON).phase, "preseason");
  items = postResults(items, 1);
  assert.equal(computeSeasonPhase(items, SEASON).phase, "locked");
  items = postResults(items, 3);
  assert.equal(computeSeasonPhase(items, SEASON).phase, "locked");
  items = postResults(items, 4);
  assert.equal(computeSeasonPhase(items, SEASON).phase, "midseasonWindow");
  items = postResults(items, 5);
  assert.equal(computeSeasonPhase(items, SEASON).phase, "postMidseason");
});

test("bottom-X is strict and uses only races through the break", () => {
  let items = postResults(baseItems(), 4);
  const eligible = computeMidSeasonEligible(items, SEASON, drivers(items), 4);
  assert.deepEqual([...eligible].sort(), ["d3", "d4", "d5", "d6"]);

  // Race 5 flips the order entirely — eligibility must not change.
  const reversed = [...DRIVER_IDS].reverse();
  items = postResults(baseItems(), 5, { 4: reversed });
  const after = computeMidSeasonEligible(items, SEASON, drivers(items), 4);
  assert.deepEqual([...after].sort(), ["d3", "d4", "d5", "d6"]);
});

test("ties at the cutoff resolve by roster order (exactly X teams)", () => {
  // Nobody scores: everyone tied on 0 points and identical histories.
  let items = baseItems({ seasonExtra: { pointsTable: [] } });
  items = postResults(items, 4);
  const eligible = computeMidSeasonEligible(items, SEASON, drivers(items), 2);
  assert.equal(eligible.size, 2);
  assert.deepEqual([...eligible].sort(), ["d5", "d6"]);
});

test("funding is added to budget only for eligible teams, from the break on", () => {
  let items = postResults(baseItems(), 3);
  let data = assembleData(items, SEASON);
  assert.ok(data.upgradeTracker.entries.every((e) => e.midSeasonFunding === 0));

  items = postResults(baseItems(), 4);
  data = assembleData(items, SEASON);
  const byId = Object.fromEntries(data.upgradeTracker.entries.map((e) => [e.driverId, e]));
  assert.equal(byId.d6.midSeasonFunding, 3000000);
  assert.equal(byId.d6.budget, 13000000);
  assert.equal(byId.d1.midSeasonFunding, 0);
  assert.equal(byId.d1.budget, 10000000);
  assert.equal(data.season.upgradeExchange.phase, "midseasonWindow");
  assert.equal(data.season.upgradeExchange.midwayRace, 4);
});

test("priority uses this season's standings through the break once it's reached", () => {
  const reversed = [...DRIVER_IDS].reverse();
  const items = postResults(baseItems(), 5, { 4: reversed });
  const upgradeRank = computePriorityOrder(items, SEASON, drivers(items));
  // Worst through race 4 (d6) picks upgrades first, despite winning race 5.
  assert.equal(upgradeRank.get("d6"), 0);
  const sponsorRank = computePriorityOrder(items, SEASON, drivers(items), { reversed: true });
  assert.equal(sponsorRank.get("d1"), 0);
});

// ---------- route enforcement ----------

let store;
function installRepoStub(items) {
  store = new Map(items.map((i) => [`${i.PK}|${i.SK}`, { ...i }]));
  repo.getAll = async () => [...store.values()];
  repo.getItem = async (key) => store.get(`${key.PK}|${key.SK}`) || null;
  repo.putItem = async (item) => { store.set(`${item.PK}|${item.SK}`, { ...item }); return item; };
}

function trackerRow(driverId, upgrades, sponsor = null) {
  return { ...keys.upgradeTracker(driverId, SEASON), itemType: itemTypes.UPGRADETRACKER, driverId, season: SEASON, sponsor, upgrades, modification: 0 };
}

// Each driver holds part #(index+1); parts 7-14 are free.
function itemsWithPicks(resultsPosted, seasonExtra) {
  const items = postResults(baseItems({ seasonExtra }), resultsPosted);
  DRIVER_IDS.forEach((d, i) => items.push(trackerRow(d, [i + 1, null, null], null)));
  return items;
}

async function put(user, driverId, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/api/upgrade-tracker", require("../server/routes/upgrade-tracker.routes"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/upgrade-tracker/${driverId}?season=${SEASON}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const asDriver = (driverId) => ({ role: "driver", driverId, username: driverId });
const ADMIN = { role: "admin", username: "admin" };

beforeEach(() => {
  store = null;
});

test("preseason: drivers can change upgrades and sponsor", async () => {
  installRepoStub(itemsWithPicks(0));
  const res = await put(asDriver("d1"), "d1", { sponsor: null, upgrades: [7, 8, null], modification: 0 });
  assert.equal(res.status, 200);
});

test("locked after race 1: driver changes rejected, unchanged save ok, admin exempt", async () => {
  installRepoStub(itemsWithPicks(1));
  const changed = await put(asDriver("d1"), "d1", { sponsor: null, upgrades: [7, null, null], modification: 0 });
  assert.equal(changed.status, 400);
  assert.match(changed.body.error, /locked/);

  const sponsor = await put(asDriver("d1"), "d1", { sponsor: "Acme", upgrades: [1, null, null], modification: 0 });
  assert.equal(sponsor.status, 400);

  // Reordering slots isn't a change.
  const same = await put(asDriver("d1"), "d1", { sponsor: null, upgrades: [null, 1, null], modification: 0 });
  assert.equal(same.status, 200);

  const admin = await put(ADMIN, "d1", { sponsor: null, upgrades: [7, null, null], modification: 0 });
  assert.equal(admin.status, 200);
});

test("lock can be turned off per season", async () => {
  installRepoStub(itemsWithPicks(1, { lockUpgradesAfterFirstRace: false }));
  const res = await put(asDriver("d1"), "d1", { sponsor: null, upgrades: [7, null, null], modification: 0 });
  assert.equal(res.status, 200);
});

test("mid-season window: bottom-X can swap up to the max, others only sponsor", async () => {
  installRepoStub(itemsWithPicks(4));
  // d6 (last) holds [6]. Give them two more parts first via admin so there are 3 to swap.
  await put(ADMIN, "d6", { sponsor: null, upgrades: [6, 9, 10], modification: 0 });

  // Baseline was frozen on that first write in the window: [6, null, null].
  // Swapping 6 out = 1 swap; fine.
  const ok = await put(asDriver("d6"), "d6", { sponsor: null, upgrades: [7, 9, 10], modification: 0 });
  assert.equal(ok.status, 200);
  assert.deepEqual(store.get(`${keys.upgradeTracker("d6", SEASON).PK}|${keys.upgradeTracker("d6", SEASON).SK}`).midSeasonBaseline, [6, null, null]);

  // Now d5 (eligible) holds [5] only — test the max with a 3-part baseline.
  await put(ADMIN, "d5", { sponsor: null, upgrades: [5, 11, 12], modification: 0 });
  installRepoStub([...store.values()].map((i) => (i.driverId === "d5" && i.itemType === itemTypes.UPGRADETRACKER ? { ...i, midSeasonBaseline: [5, 11, 12] } : i)));
  const two = await put(asDriver("d5"), "d5", { sponsor: null, upgrades: [5, 13, 14], modification: 0 });
  assert.equal(two.status, 200);
  const three = await put(asDriver("d5"), "d5", { sponsor: null, upgrades: [8, 13, 14], modification: 0 });
  assert.equal(three.status, 400);
  assert.match(three.body.error, /only swap 2/);

  // d1 (leader) isn't eligible for upgrades but can change sponsor.
  const notEligible = await put(asDriver("d1"), "d1", { sponsor: null, upgrades: [8, null, null], modification: 0 });
  assert.equal(notEligible.status, 400);
  assert.match(notEligible.body.error, /bottom 4/);
  const sponsor = await put(asDriver("d1"), "d1", { sponsor: "Acme", upgrades: [1, null, null], modification: 0 });
  assert.equal(sponsor.status, 200);
});

test("after the next race: locked again", async () => {
  installRepoStub(itemsWithPicks(5));
  const res = await put(asDriver("d6"), "d6", { sponsor: null, upgrades: [7, null, null], modification: 0 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /closed/);
});

test("a negative remaining budget is flagged like an upgrade conflict", () => {
  const items = baseItems({ seasonExtra: { baseTeamBudget: 150000 } });
  items.push(trackerRow("d1", [1, 2, null])); // 2 x 100,000 against 150,000
  items.push(trackerRow("d2", [3, null, null])); // within budget
  const byId = Object.fromEntries(assembleData(items, SEASON).upgradeTracker.entries.map((e) => [e.driverId, e]));
  assert.equal(byId.d1.outOfCompliance, true);
  assert.deepEqual(byId.d1.complianceIssues, [{ overBudget: 50000 }]);
  assert.equal(byId.d2.outOfCompliance, false);
});

// ---------- mid-season availability (no stealing) ----------

function windowItemsWithSponsors() {
  const items = itemsWithPicks(4);
  for (const name of ["Acme", "Bolt"]) items.push({ ...keys.sponsor(name), itemType: itemTypes.SPONSOR, name, funding: 0 });
  // d2 goes into the break holding Acme.
  const d2 = items.find((i) => i.itemType === itemTypes.UPGRADETRACKER && i.driverId === "d2");
  d2.sponsor = "Acme";
  return items;
}

test("mid-season: a part held going into the break can't be taken, even by higher priority", async () => {
  installRepoStub(windowItemsWithSponsors());
  // d6 (last place = first upgrade priority) tries d3's retained part #3.
  const res = await put(asDriver("d6"), "d6", { sponsor: null, upgrades: [3, null, null], modification: 0 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Part #3 isn't available/);
});

test("mid-season: a higher-priority team can take a part a lower-priority team swapped to, not the reverse", async () => {
  installRepoStub(windowItemsWithSponsors());
  // d3 (lower upgrade priority than d6) swaps to free part #7 first.
  assert.equal((await put(asDriver("d3"), "d3", { sponsor: null, upgrades: [7, null, null], modification: 0 })).status, 200);
  // d4 is higher priority than d3, so d4 can take #7 — d3 gets flagged.
  assert.equal((await put(asDriver("d4"), "d4", { sponsor: null, upgrades: [7, null, null], modification: 0 })).status, 200);
  const data = assembleData([...store.values()], SEASON);
  const d3 = data.upgradeTracker.entries.find((e) => e.driverId === "d3");
  assert.equal(d3.outOfCompliance, true);
  // d5 (higher priority than d4) could still take #7.
  assert.ok(!data.upgradeTracker.entries.find((e) => e.driverId === "d5").blockedParts.includes(7));
  // Part #4, which d4 swapped away, is back in the pool and open to d3.
  assert.ok(!data.upgradeTracker.entries.find((e) => e.driverId === "d3").blockedParts.includes(4));
});

test("mid-season: a lower-priority team can't take a part a higher-priority team already swapped to", async () => {
  installRepoStub(windowItemsWithSponsors());
  assert.equal((await put(asDriver("d6"), "d6", { sponsor: null, upgrades: [7, null, null], modification: 0 })).status, 200);
  const res = await put(asDriver("d5"), "d5", { sponsor: null, upgrades: [7, null, null], modification: 0 });
  assert.equal(res.status, 400);
});

test("mid-season: sponsors held going into the break can't be taken; fresh sponsor picks go by priority", async () => {
  installRepoStub(windowItemsWithSponsors());
  // d1 (leader = first sponsor priority) can't take d2's retained Acme.
  const steal = await put(asDriver("d1"), "d1", { sponsor: "Acme", upgrades: [1, null, null], modification: 0 });
  assert.equal(steal.status, 400);
  assert.match(steal.body.error, /Acme/);

  // d4 picks free Bolt; d1 (higher sponsor priority) can still take it.
  assert.equal((await put(asDriver("d4"), "d4", { sponsor: "Bolt", upgrades: [4, null, null], modification: 0 })).status, 200);
  assert.equal((await put(asDriver("d1"), "d1", { sponsor: "Bolt", upgrades: [1, null, null], modification: 0 })).status, 200);
  // ...but d5 (lower than both) can't.
  const late = await put(asDriver("d5"), "d5", { sponsor: "Bolt", upgrades: [5, null, null], modification: 0 });
  assert.equal(late.status, 400);

  const d2 = assembleData([...store.values()], SEASON).upgradeTracker.entries.find((e) => e.driverId === "d2");
  assert.equal(d2.outOfCompliance, false, "the team that kept Acme stays compliant");
});
