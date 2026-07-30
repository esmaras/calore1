const express = require("express");
const repo = require("../db/repo");
const { keys, itemTypes, slugify } = require("../db/keys");
const { hashPassword, generateTempPassword } = require("../auth/passwords");
const { renameUser } = require("../auth/users");

// Mounted with requireAdmin already applied at the app level (server/index.js)
// — everything under /api/admin is admin-only, so no per-route check needed.
const router = express.Router();

// ---------- Inventory: admin-only edits to existing rows ----------
// (Adding/removing parts or sponsors isn't wired up yet — this is just
// enough to unblock "admin can edit the inventory".)
const UPGRADE_PART_FIELDS = ["type", "effect", "countAvailable", "tier", "cost"];
router.put("/upgrade-parts/:partNumber", async (req, res) => {
  const partNumber = Number(req.params.partNumber);
  const existing = await repo.getItem(keys.upgradePart(partNumber));
  if (!existing) return res.status(404).json({ error: "No such upgrade part" });
  const attrs = {};
  for (const f of UPGRADE_PART_FIELDS) if (f in req.body) attrs[f] = req.body[f];
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No fields provided" });
  const updated = await repo.updateItem(keys.upgradePart(partNumber), attrs);
  res.json(updated);
});

// ---------- Car colors: admin-managed allowed-values list ----------
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
router.post("/car-colors", async (req, res) => {
  const { name, hex } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Color name is required" });
  if (!hex || !HEX_RE.test(hex)) return res.status(400).json({ error: "hex must look like #rrggbb" });
  const clean = String(name).trim();

  try {
    await repo.transactWrite([
      { Put: { Item: { ...keys.carColorConfig(clean), itemType: itemTypes.CARCOLORCONFIG, name: clean, hex, active: true }, ConditionExpression: "attribute_not_exists(PK)" } },
    ]);
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return res.status(409).json({ error: `"${clean}" is already an allowed color.` });
    }
    throw err;
  }
  res.json({ name: clean, hex, active: true });
});

// Retire a color from the allowed list rather than hard-deleting it — a
// driver may already be holding it (their CARCOLORCLAIM), so removing the
// config entry outright would leave that claim pointing at a color that
// no longer validates. Marking inactive is enough to stop new claims.
router.delete("/car-colors/:name", async (req, res) => {
  const existing = await repo.getItem(keys.carColorConfig(req.params.name));
  if (!existing) return res.status(404).json({ error: "No such color" });
  await repo.updateItem(keys.carColorConfig(req.params.name), { active: false });
  res.json({ ok: true });
});

const SPONSOR_FIELDS = ["name", "type", "countAvailable", "funding"];
router.put("/sponsors/:sponsorId", async (req, res) => {
  const { sponsorId } = req.params;
  const existing = await repo.getItem(keys.sponsor(sponsorId));
  if (!existing) return res.status(404).json({ error: "No such sponsor" });
  const attrs = {};
  for (const f of SPONSOR_FIELDS) if (f in req.body) attrs[f] = req.body[f];
  if (Object.keys(attrs).length === 0) return res.status(400).json({ error: "No fields provided" });
  const updated = await repo.updateItem(keys.sponsor(sponsorId), attrs);
  res.json(updated);
});

// ---------- Users: full account list ----------
// Never includes passwordHash — this is a read-only overview for the admin
// panel, not an auth-debugging endpoint.
router.get("/users", async (req, res) => {
  const all = await repo.getAll();
  const users = all
    .filter((i) => i.itemType === itemTypes.USER)
    .map((u) => ({ username: u.username, role: u.role, driverId: u.driverId ?? null, mustChangePassword: !!u.mustChangePassword }))
    .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === "admin" ? -1 : 1));
  res.json(users);
});

// ---------- Drivers: create new + reset password ----------
// A new driver needs both a DRIVER record and a USER login created
// together — created via one transaction so we never end up with one
// without the other. Per-driver STANDINGS/UPGRADETRACKER/FICCPROPOSAL rows
// don't need to be pre-created: assemble.js already defaults them to empty
// when missing, same as it does for any existing driver with a gap.
router.post("/drivers", async (req, res) => {
  const { player, driver, teamName, backstory } = req.body || {};
  if (!driver || !String(driver).trim()) return res.status(400).json({ error: "Driver name is required" });

  const all = await repo.getAll();
  const driverItems = all.filter((i) => i.itemType === itemTypes.DRIVER);
  const nextOrder = driverItems.length ? Math.max(...driverItems.map((d) => d.order ?? 0)) + 1 : 0;

  const base = slugify(driver);
  if (!base) return res.status(400).json({ error: "Could not derive a valid id from that driver name" });
  const existingIds = new Set(driverItems.map((d) => d.driverId));
  let driverId = base;
  let suffix = 2;
  while (existingIds.has(driverId)) driverId = `${base}-${suffix++}`;

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const driverItem = {
    ...keys.driver(driverId),
    itemType: itemTypes.DRIVER,
    driverId,
    order: nextOrder,
    player: player || "",
    driver,
    teamName: teamName || "",
    carColor: null,
    backstory: backstory || "",
  };
  const userItem = {
    ...keys.user(driverId),
    itemType: itemTypes.USER,
    username: driverId,
    passwordHash,
    role: "driver",
    driverId,
    mustChangePassword: true,
  };

  try {
    await repo.transactWrite([
      { Put: { Item: driverItem, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { Item: userItem, ConditionExpression: "attribute_not_exists(PK)" } },
    ]);
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return res.status(409).json({ error: "That driver name maps to an id/username that's already taken — try a slightly different name." });
    }
    throw err;
  }

  res.json({ driver: { player: driverItem.player, driver: driverItem.driver, teamName: driverItem.teamName, carColor: null, backstory: driverItem.backstory, driverId }, username: driverId, tempPassword });
});

// Deletes the driver's roster entry and their login together — leaving
// either behind would strand a login nobody can attach to a driver, or a
// driver nobody can log in as. Also frees their car color claim, if any,
// so it becomes available to other drivers again. Deliberately does NOT
// clean up their historical STANDINGS/UPGRADETRACKER/FICC_PROPOSAL rows
// (per-season, keyed by driverId) — those simply stop appearing anywhere
// once the DRIVER item is gone (assembleData only ever iterates driverIds
// from existing DRIVER items), so leaving them is harmless, and deleting
// them would mean scanning and removing rows across every season.
router.delete("/drivers/:driverId", async (req, res) => {
  const { driverId } = req.params;
  const driver = await repo.getItem(keys.driver(driverId));
  if (!driver) return res.status(404).json({ error: "No such driver" });

  // The driver's login username isn't necessarily driverId — admins can
  // rename it independently (see PUT /users/:username/username) — so the
  // matching USER item has to be found by its driverId attribute, not by
  // constructing USER#<driverId> and assuming that's still the key.
  const all = await repo.getAll();
  const userItem = all.find((i) => i.itemType === itemTypes.USER && i.driverId === driverId);

  const deletes = [{ Delete: { Key: keys.driver(driverId) } }];
  if (userItem) deletes.push({ Delete: { Key: keys.user(userItem.username) } });
  if (driver.carColor) deletes.push({ Delete: { Key: keys.carColorClaim(driver.carColor) } });
  await repo.transactWrite(deletes);
  res.json({ ok: true });
});

router.post("/users/:username/reset-password", async (req, res) => {
  const { username } = req.params;
  const existing = await repo.getItem(keys.user(username));
  if (!existing) return res.status(404).json({ error: "No such user" });
  // Temp password is just the username itself — easy to relay verbally,
  // and mustChangePassword forces a real password on next login anyway.
  const tempPassword = username;
  const passwordHash = await hashPassword(tempPassword);
  await repo.updateItem(keys.user(username), { passwordHash, mustChangePassword: true });
  res.json({ username, tempPassword });
});

// Admin can rename any user's login — usernames are independent of
// driverId, e.g. tied to the person's own name rather than their driver's.
router.put("/users/:username/username", async (req, res) => {
  const { username } = req.params;
  const { newUsername } = req.body || {};
  if (!newUsername || !newUsername.trim()) return res.status(400).json({ error: "New username is required" });
  try {
    const updated = await renameUser(username, newUsername.trim());
    res.json({ username: updated.username });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
