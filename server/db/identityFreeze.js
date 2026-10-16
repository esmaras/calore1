const repo = require("./repo");
const { keys, itemTypes } = require("./keys");
const { driversAsOfSeason } = require("./ranking");

// Every DRIVER field that's part of how a driver is shown in a season's
// record — exactly the set driverIdentityResolver (server/db/assemble.js)
// lets an ended season's endedDriverIdentities snapshot override. `player`
// (the real person) is deliberately NOT here; that always reads live.
const IDENTITY_FIELDS = ["driver", "teamName", "backstory", "driverNumber", "numberFont", "numberBgShape", "numberBgColor", "carColor"];

// Freeze-on-edit, the safety net behind freeze-on-end (POST
// /:seasonNumber/end). A season's snapshot only covers whatever fields it
// captured at the moment it ended — so a season that ended before a field
// joined the snapshot (or before snapshots existed at all, like 1961) has
// gaps, and any gap falls back to the driver's LIVE record. Editing that
// field then silently rewrites the past season, which is how renames and
// team/bio changes kept leaking backwards one field at a time.
//
// Call this BEFORE writing the edit: for every ended season this driver
// was on the roster for, any changed field the snapshot doesn't already
// hold gets pinned to its outgoing value — i.e. exactly what that season
// was displaying a moment ago. Fields the snapshot already has are never
// touched, so a genuinely frozen value always wins.
async function freezeIdentityBeforeEdit(driverBefore, changedFields) {
  const fields = changedFields.filter((f) => IDENTITY_FIELDS.includes(f));
  if (fields.length === 0) return;

  const endedSeasons = (await repo.getAll()).filter(
    (i) => i.itemType === itemTypes.SEASON && i.ended && driversAsOfSeason([driverBefore], i.seasonNumber).length > 0
  );

  for (const season of endedSeasons) {
    const identities = Array.isArray(season.endedDriverIdentities) ? season.endedDriverIdentities : [];
    const idx = identities.findIndex((d) => d.driverId === driverBefore.driverId);
    const entry = idx === -1 ? { driverId: driverBefore.driverId } : { ...identities[idx] };
    const missing = fields.filter((f) => !(f in entry));
    if (missing.length === 0) continue;
    for (const f of missing) entry[f] = driverBefore[f] ?? null;

    const next = idx === -1 ? [...identities, entry] : identities.map((d, i) => (i === idx ? entry : d));
    await repo.updateItem(keys.season(season.seasonNumber), { endedDriverIdentities: next });
  }
}

module.exports = { IDENTITY_FIELDS, freezeIdentityBeforeEdit };
