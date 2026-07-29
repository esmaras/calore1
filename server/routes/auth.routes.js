const express = require("express");
const repo = require("../db/repo");
const { keys } = require("../db/keys");
const { verifyPassword, hashPassword } = require("../auth/passwords");
const { COOKIE_NAME, SESSION_MS, requireAuth, setSessionCookie } = require("../auth/middleware");
const { renameUser } = require("../auth/users");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });

  const user = await repo.getItem(keys.user(username));
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password" });

  const now = Date.now();
  setSessionCookie(res, {
    username: user.username,
    role: user.role,
    driverId: user.driverId || null,
    issuedAt: now,
    expiresAt: now + SESSION_MS,
  });
  res.json({
    username: user.username,
    role: user.role,
    driverId: user.driverId || null,
    mustChangePassword: !!user.mustChangePassword,
  });
});

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await repo.getItem(keys.user(req.user.username));
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({
    username: user.username,
    role: user.role,
    driverId: user.driverId || null,
    mustChangePassword: !!user.mustChangePassword,
  });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  const user = await repo.getItem(keys.user(req.user.username));
  const ok = await verifyPassword(currentPassword, user?.passwordHash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await hashPassword(newPassword);
  await repo.updateItem(keys.user(req.user.username), { passwordHash, mustChangePassword: false });
  res.json({ ok: true });
});

// Self-service username change — a user can only rename themselves (the
// route acts on req.user.username, there's no :username param to spoof).
// Since the session cookie encodes the username, a successful rename must
// reissue the cookie or the next request would look up a PK that no
// longer exists and the user would be silently logged out.
router.put("/username", requireAuth, async (req, res) => {
  const { newUsername } = req.body || {};
  if (!newUsername || !newUsername.trim()) return res.status(400).json({ error: "New username is required" });

  try {
    const updated = await renameUser(req.user.username, newUsername.trim());
    const now = Date.now();
    setSessionCookie(res, {
      username: updated.username,
      role: updated.role,
      driverId: updated.driverId || null,
      issuedAt: now,
      expiresAt: now + SESSION_MS,
    });
    res.json({ username: updated.username });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
