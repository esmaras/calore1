// Integration tests for the three highest-risk security paths identified
// in the plan: concurrent car-color claim, cross-driver write rejection,
// and admin-route rejection — plus username-uniqueness, added once
// usernames became renameable and independent of driverId.
//
// Runs against a real DynamoDB (Local, by default — see README) and a
// real Express app instance on an ephemeral port. Fixtures are created
// directly through the repo/auth layers (not via HTTP signup, since there
// is none) with unique, randomly-suffixed ids so repeated runs never
// collide with each other or with real seeded data from manual testing.
//
// Prerequisites: DynamoDB Local running + table created (see README's
// "Running locally" — steps 1-2). Run with: npm test

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const app = require("../server/app");
const repo = require("../server/db/repo");
const { keys, itemTypes } = require("../server/db/keys");
const { hashPassword } = require("../server/auth/passwords");

let server;
let baseUrl;
const runId = crypto.randomBytes(4).toString("hex");
const cleanupKeys = [];

function trackedKey(key) {
  cleanupKeys.push(key);
  return key;
}

async function putFixture(item) {
  await repo.putItem(item);
  trackedKey({ PK: item.PK, SK: item.SK });
}

// Minimal cookie jar: captures Set-Cookie from a login response and
// replays it on subsequent requests, since plain fetch() has none.
function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

async function loginAs(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login for ${username} should succeed`);
  return extractCookie(res);
}

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  for (const key of cleanupKeys) {
    // eslint-disable-next-line no-await-in-loop
    await repo.deleteItem(key).catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
});

test("admin-only route rejects a driver session", async () => {
  const driverId = `test-driver-a-${runId}`;
  const username = `test-user-a-${runId}`;
  const password = "correct-horse-battery";

  await putFixture({ ...keys.driver(driverId), itemType: itemTypes.DRIVER, driverId, order: 999, player: "P", driver: "Test Driver A", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.user(username), itemType: itemTypes.USER, username, passwordHash: await hashPassword(password), role: "driver", driverId, mustChangePassword: false });

  const cookie = await loginAs(username, password);
  const res = await fetch(`${baseUrl}/api/admin/drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ driver: "Should Not Be Created" }),
  });
  assert.equal(res.status, 403);
});

test("a driver cannot write another driver's profile", async () => {
  const driverIdA = `test-driver-b1-${runId}`;
  const driverIdB = `test-driver-b2-${runId}`;
  const usernameA = `test-user-b1-${runId}`;
  const password = "correct-horse-battery";

  await putFixture({ ...keys.driver(driverIdA), itemType: itemTypes.DRIVER, driverId: driverIdA, order: 999, player: "P", driver: "Test Driver B1", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.driver(driverIdB), itemType: itemTypes.DRIVER, driverId: driverIdB, order: 999, player: "P", driver: "Test Driver B2", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.user(usernameA), itemType: itemTypes.USER, username: usernameA, passwordHash: await hashPassword(password), role: "driver", driverId: driverIdA, mustChangePassword: false });

  const cookie = await loginAs(usernameA, password);

  // Editing their own record works.
  const ownRes = await fetch(`${baseUrl}/api/drivers/${driverIdA}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ backstory: "updated by self" }),
  });
  assert.equal(ownRes.status, 200);

  // Editing someone else's record does not, even with a crafted request.
  const otherRes = await fetch(`${baseUrl}/api/drivers/${driverIdB}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ backstory: "hacked" }),
  });
  assert.equal(otherRes.status, 403);

  const untouched = await repo.getItem(keys.driver(driverIdB));
  assert.equal(untouched.backstory, "", "the other driver's record must be unchanged");
});

test("concurrent car-color claims: exactly one succeeds, the other 409s", async () => {
  const colorName = `Testmauve-${runId}`;
  await putFixture({ ...keys.carColorConfig(colorName), itemType: itemTypes.CARCOLORCONFIG, name: colorName, hex: "#abcdef", active: true });

  const driverIdA = `test-driver-c1-${runId}`;
  const driverIdB = `test-driver-c2-${runId}`;
  const usernameA = `test-user-c1-${runId}`;
  const usernameB = `test-user-c2-${runId}`;
  const password = "correct-horse-battery";

  await putFixture({ ...keys.driver(driverIdA), itemType: itemTypes.DRIVER, driverId: driverIdA, order: 999, player: "P", driver: "Test Driver C1", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.driver(driverIdB), itemType: itemTypes.DRIVER, driverId: driverIdB, order: 999, player: "P", driver: "Test Driver C2", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.user(usernameA), itemType: itemTypes.USER, username: usernameA, passwordHash: await hashPassword(password), role: "driver", driverId: driverIdA, mustChangePassword: false });
  await putFixture({ ...keys.user(usernameB), itemType: itemTypes.USER, username: usernameB, passwordHash: await hashPassword(password), role: "driver", driverId: driverIdB, mustChangePassword: false });

  const [cookieA, cookieB] = await Promise.all([loginAs(usernameA, password), loginAs(usernameB, password)]);

  const claim = (driverId, cookie) =>
    fetch(`${baseUrl}/api/drivers/${driverId}/car-color`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carColor: colorName }),
    });

  const [resA, resB] = await Promise.all([claim(driverIdA, cookieA), claim(driverIdB, cookieB)]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one claim should win and one should conflict");

  trackedKey(keys.carColorClaim(colorName));
});

test("username uniqueness: renaming to a username already in use is rejected", async () => {
  const driverIdA = `test-driver-d1-${runId}`;
  const driverIdB = `test-driver-d2-${runId}`;
  const usernameA = `test-user-d1-${runId}`;
  const usernameB = `test-user-d2-${runId}`;
  const password = "correct-horse-battery";

  await putFixture({ ...keys.driver(driverIdA), itemType: itemTypes.DRIVER, driverId: driverIdA, order: 999, player: "P", driver: "Test Driver D1", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.driver(driverIdB), itemType: itemTypes.DRIVER, driverId: driverIdB, order: 999, player: "P", driver: "Test Driver D2", teamName: "T", carColor: null, backstory: "" });
  await putFixture({ ...keys.user(usernameA), itemType: itemTypes.USER, username: usernameA, passwordHash: await hashPassword(password), role: "driver", driverId: driverIdA, mustChangePassword: false });
  await putFixture({ ...keys.user(usernameB), itemType: itemTypes.USER, username: usernameB, passwordHash: await hashPassword(password), role: "driver", driverId: driverIdB, mustChangePassword: false });

  const cookieA = await loginAs(usernameA, password);
  const res = await fetch(`${baseUrl}/api/auth/username`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ newUsername: usernameB }),
  });
  assert.equal(res.status, 409);

  const stillA = await repo.getItem(keys.user(usernameA));
  assert.ok(stillA, "the original username must still exist — a failed rename must not delete it");
});
