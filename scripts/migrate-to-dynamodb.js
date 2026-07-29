#!/usr/bin/env node
// One-time migration: reads the LIVE data.json (never extract.py/.xlsx —
// data.json has already diverged from what extract.py would produce,
// since the app has been used and has written properly-shaped rows that
// extract.py doesn't know how to generate) and writes everything into
// DynamoDB in the new item shape described in the plan doc.
//
// Usage:
//   node --env-file=.env scripts/migrate-to-dynamodb.js --admin-password=<pw>
//
// Refuses to run without an explicit admin password (no hardcoded default).
// Prints each driver's generated username + temp password once, to relay
// out-of-band — these are never written to a file.

const fs = require("fs");
const path = require("path");
const repo = require("../server/db/repo");
const { keys, itemTypes, slugify } = require("../server/db/keys");

// This migration always seeds the original spreadsheet data as season 1,
// labeled "1961" (the year the campaign is set in) — later seasons are
// created via the admin UI (Season & Schedule tab), not this script.
const SEASON_NUMBER = 1;
const SEASON_LABEL = "1961";
const { hashPassword, generateTempPassword } = require("../server/auth/passwords");

const DATA_JSON_PATH = path.join(__dirname, "..", "data.json");

const CAR_COLORS = {
  Silver: "#c9cdd3",
  Black: "#3a3a3a",
  Blue: "#3a7bd5",
  Green: "#3ba55d",
  Yellow: "#e8c547",
  Purple: "#8e5bd8",
  Orange: "#e8823c",
  Red: "#e05353",
  White: "#f5f5f5",
};

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function toNumberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const args = parseArgs();
  if (!args["admin-password"]) {
    console.error(
      "Refusing to run: pass --admin-password=<something> (e.g. node --env-file=.env scripts/migrate-to-dynamodb.js --admin-password=changeme123)"
    );
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, "utf8"));

  // ---- driver id map ----
  const driverIdByName = {};
  data.drivers.forEach((d) => {
    driverIdByName[d.driver] = slugify(d.driver);
  });
  console.log("Driver id map:");
  for (const [name, id] of Object.entries(driverIdByName)) console.log(`  ${name} -> ${id}`);
  console.log();

  const puts = [];
  const credentialsToPrint = [];

  // ---- drivers + car color claims ----
  data.drivers.forEach((d, order) => {
    const driverId = driverIdByName[d.driver];
    puts.push({
      ...keys.driver(driverId),
      itemType: itemTypes.DRIVER,
      driverId,
      order, // preserves original lineup display order across all per-driver items
      player: d.player,
      driver: d.driver,
      teamName: d.teamName,
      carColor: d.carColor,
      backstory: d.backstory,
    });
    if (d.carColor) {
      puts.push({ ...keys.carColorClaim(d.carColor), itemType: itemTypes.CARCOLORCLAIM, driverId });
    }
  });

  // ---- allowed car colors (existing 8 + White already included above) ----
  for (const [name, hex] of Object.entries(CAR_COLORS)) {
    puts.push({ ...keys.carColorConfig(name), itemType: itemTypes.CARCOLORCONFIG, name, hex, active: true });
  }

  // ---- upgrade parts + sponsors ----
  for (const u of data.inventory.upgrades) {
    puts.push({
      ...keys.upgradePart(u.partNumber),
      itemType: itemTypes.UPGRADEPART,
      partNumber: u.partNumber,
      type: u.type,
      effect: u.effect,
      countAvailable: u.countAvailable,
      tier: u.tier,
      cost: u.cost,
    });
  }
  for (const s of data.inventory.sponsors) {
    const slug = slugify(s.name);
    puts.push({
      ...keys.sponsor(slug),
      itemType: itemTypes.SPONSOR,
      sponsorId: slug,
      name: s.name,
      type: s.type,
      countAvailable: s.countAvailable,
      funding: s.funding,
    });
  }

  // ---- season config ----
  puts.push({
    ...keys.season(SEASON_NUMBER),
    itemType: itemTypes.SEASON,
    seasonNumber: SEASON_NUMBER,
    label: SEASON_LABEL,
    racesThisSeason: toNumberOr(data.season.racesThisSeason, data.season.schedule.length),
    upgradeSlots: toNumberOr(data.season.upgradeSlots, 3),
    trackSelectionMethod: data.season.trackSelectionMethod,
    midSeasonBreakAfterRace: data.season.midSeasonBreakAfterRace,
    legends: data.season.legends,
    baseTeamBudget: toNumberOr(data.season.baseTeamBudget, 0),
    schedule: data.season.schedule,
    raceLabels: data.standings.raceLabels,
    pointsTable: data.standings.pointsTable,
  });

  // The "current season" pointer — defaults to the freshly-seeded season 1.
  puts.push({ ...keys.currentSeasonPointer(), itemType: itemTypes.CURRENTSEASON_POINTER, seasonNumber: SEASON_NUMBER });

  // ---- standings + upgrade tracker (per driver, derived fields dropped) ----
  data.standings.drivers.forEach((row, i) => {
    const driverId = driverIdByName[row.driver];
    if (!driverId) return;
    puts.push({
      ...keys.standings(driverId, SEASON_NUMBER),
      itemType: itemTypes.STANDINGS,
      driverId,
      season: SEASON_NUMBER,
      races: row.races,
    });
  });
  data.upgradeTracker.entries.forEach((row, i) => {
    const driverId = driverIdByName[row.driver];
    if (!driverId) return;
    puts.push({
      ...keys.upgradeTracker(driverId, SEASON_NUMBER),
      itemType: itemTypes.UPGRADETRACKER,
      driverId,
      season: SEASON_NUMBER,
      sponsor: row.sponsor,
      upgrades: row.upgrades,
      modification: row.modification,
    });
  });

  // ---- blob docs ----
  puts.push({ ...keys.lore(), itemType: itemTypes.LORE, ...data.lore });
  puts.push({ ...keys.techRegs(), itemType: itemTypes.TECHREGS, items: data.technicalRegulations });
  puts.push({ ...keys.ficcNotes(SEASON_NUMBER), itemType: itemTypes.FICC_NOTES, season: SEASON_NUMBER, notes: data.ficcBacklog.notes });
  puts.push({
    ...keys.upgradeTrackerLegend(),
    itemType: itemTypes.UPGRADETRACKER_LEGEND,
    legend: data.upgradeTracker.legend,
    rule: data.upgradeTracker.rule,
  });
  puts.push({ ...keys.hallOfFameSeasonLog(), itemType: itemTypes.HALLOFFAME_SEASONLOG, items: data.hallOfFame.seasonLog });
  puts.push({ ...keys.hallOfFameMissedRaceLog(), itemType: itemTypes.HALLOFFAME_MISSEDRACELOG, items: data.hallOfFame.missedRaceLog });
  puts.push({ ...keys.offSeasonRegulations(), itemType: itemTypes.OFFSEASON_REGULATIONS, items: data.offSeasonBudget.regulations });
  puts.push({ ...keys.offSeasonDriverTracker(), itemType: itemTypes.OFFSEASON_DRIVERTRACKER, items: data.offSeasonBudget.driverTracker });
  puts.push({ ...keys.offSeasonMidSeasonWindow(), itemType: itemTypes.OFFSEASON_MIDSEASONWINDOW, items: data.offSeasonBudget.midSeasonWindow });

  // ---- FICC proposals: first N (driver count) rows are driver-owned, rest freeform ----
  const driverCount = data.drivers.length;
  data.ficcBacklog.proposals.forEach((p, i) => {
    if (i < driverCount) {
      const driverId = driverIdByName[p.driverName];
      if (!driverId) return;
      puts.push({
        ...keys.ficcProposal(driverId, SEASON_NUMBER),
        itemType: itemTypes.FICC_PROPOSAL,
        driverId,
        season: SEASON_NUMBER,
        regulationName: p.regulationName,
        type: p.type,
        explanation: p.explanation,
        expiration: p.expiration,
      });
    }
  });
  const freeformProposals = data.ficcBacklog.proposals.slice(driverCount);
  puts.push({
    ...keys.ficcProposalFreeform(SEASON_NUMBER),
    itemType: itemTypes.FICC_PROPOSAL_FREEFORM,
    season: SEASON_NUMBER,
    items: freeformProposals,
  });

  // ---- users: admin + one per driver ----
  const adminHash = await hashPassword(args["admin-password"]);
  puts.push({
    ...keys.user("admin"),
    itemType: itemTypes.USER,
    username: "admin",
    passwordHash: adminHash,
    role: "admin",
    mustChangePassword: false,
  });

  for (const [name, driverId] of Object.entries(driverIdByName)) {
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    puts.push({
      ...keys.user(driverId),
      itemType: itemTypes.USER,
      username: driverId,
      passwordHash,
      role: "driver",
      driverId,
      mustChangePassword: true,
    });
    credentialsToPrint.push({ driver: name, username: driverId, tempPassword });
  }

  // ---- write everything ----
  console.log(`Writing ${puts.length} items to DynamoDB...`);
  await repo.putItemsBulk(puts);
  console.log("Done.\n");

  console.log("=== Driver login credentials (relay these out-of-band, shown only once) ===");
  for (const c of credentialsToPrint) {
    console.log(`  ${c.driver.padEnd(24)} username: ${c.username.padEnd(24)} temp password: ${c.tempPassword}`);
  }
  console.log("\nAdmin username: admin (password: the one you passed via --admin-password)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
