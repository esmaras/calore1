// Single source of truth for DynamoDB PK/SK formats. Every item also gets
// an `itemType` attribute (matching the exported name below) so a full
// table Scan can be grouped/filtered in memory without parsing keys.

// Season-scoped keys require an explicit season number — no default, on
// purpose. Silently falling back to "season 1" if a caller forgot to pass
// one would be a much worse bug (data quietly written to the wrong
// season) than a loud crash pointing at the missing argument.
function requireSeason(season) {
  if (season == null) throw new Error("season is required for this key");
  return season;
}

const keys = {
  user: (username) => ({ PK: `USER#${username}`, SK: "PROFILE" }),
  driver: (driverId) => ({ PK: `DRIVER#${driverId}`, SK: "PROFILE" }),
  carColorClaim: (colorName) => ({ PK: `CARCOLORCLAIM#${colorName}`, SK: "CLAIM" }),
  carColorConfig: (colorName) => ({ PK: `CONFIG#CARCOLOR#${colorName}`, SK: "PROFILE" }),
  upgradePart: (partNumber) => ({ PK: `UPGRADEPART#${partNumber}`, SK: "PROFILE" }),
  sponsor: (sponsorSlug) => ({ PK: `SPONSOR#${sponsorSlug}`, SK: "PROFILE" }),
  standings: (driverId, season) => ({ PK: `STANDINGS#${driverId}`, SK: `SEASON#${requireSeason(season)}` }),
  upgradeTracker: (driverId, season) => ({ PK: `UPGRADETRACKER#${driverId}`, SK: `SEASON#${requireSeason(season)}` }),
  upgradeTrackerLegend: () => ({ PK: "UPGRADETRACKER#LEGEND", SK: "PROFILE" }),
  season: (season) => ({ PK: `SEASON#${requireSeason(season)}`, SK: "CONFIG" }),
  // The one non-season-scoped pointer: which season number is "current"
  // (the default view when nobody's picked a specific one, and where
  // Standings/Upgrade Tracker/FICC edits go unless a season is specified).
  currentSeasonPointer: () => ({ PK: "CONFIG#CURRENTSEASON", SK: "PROFILE" }),
  lore: () => ({ PK: "LORE#1", SK: "PROFILE" }),
  // Season-scoped (not one shared global list) — a regulation that
  // applied in one season and isn't renewed shouldn't vanish from that
  // season's historical record, which a single mutable global list can't
  // represent.
  techRegs: (season) => ({ PK: "TECHREGS", SK: `SEASON#${requireSeason(season)}` }),
  ficcNotes: (season) => ({ PK: "FICCNOTES", SK: `SEASON#${requireSeason(season)}` }),
  ficcProposal: (driverId, season) => ({ PK: `FICCPROPOSAL#${driverId}`, SK: `SEASON#${requireSeason(season)}` }),
  ficcProposalFreeform: (season) => ({ PK: "FICCPROPOSALFREEFORM", SK: `SEASON#${requireSeason(season)}` }),
  hallOfFameSeasonLog: () => ({ PK: "HALLOFFAME#SEASONLOG", SK: "PROFILE" }),
  hallOfFameMissedRaceLog: () => ({ PK: "HALLOFFAME#MISSEDRACELOG", SK: "PROFILE" }),
  offSeasonRegulations: () => ({ PK: "OFFSEASON#REGULATIONS", SK: "PROFILE" }),
  offSeasonDriverTracker: () => ({ PK: "OFFSEASON#DRIVERTRACKER", SK: "PROFILE" }),
  offSeasonMidSeasonWindow: () => ({ PK: "OFFSEASON#MIDSEASONWINDOW", SK: "PROFILE" }),
  // One row per driver per season — what that driver won based on their
  // final standing in `season`. Read by the next season's creation to
  // seed each driver's starting budget carryover.
  offSeasonWinnings: (driverId, season) => ({ PK: `OFFSEASONWINNINGS#${driverId}`, SK: `SEASON#${requireSeason(season)}` }),
};

const itemTypes = {
  USER: "USER",
  DRIVER: "DRIVER",
  CARCOLORCLAIM: "CARCOLORCLAIM",
  CARCOLORCONFIG: "CARCOLORCONFIG",
  UPGRADEPART: "UPGRADEPART",
  SPONSOR: "SPONSOR",
  STANDINGS: "STANDINGS",
  UPGRADETRACKER: "UPGRADETRACKER",
  UPGRADETRACKER_LEGEND: "UPGRADETRACKER_LEGEND",
  SEASON: "SEASON",
  CURRENTSEASON_POINTER: "CURRENTSEASON_POINTER",
  LORE: "LORE",
  TECHREGS: "TECHREGS",
  FICC_NOTES: "FICC_NOTES",
  FICC_PROPOSAL: "FICC_PROPOSAL",
  FICC_PROPOSAL_FREEFORM: "FICC_PROPOSAL_FREEFORM",
  HALLOFFAME_SEASONLOG: "HALLOFFAME_SEASONLOG",
  HALLOFFAME_MISSEDRACELOG: "HALLOFFAME_MISSEDRACELOG",
  OFFSEASON_REGULATIONS: "OFFSEASON_REGULATIONS",
  OFFSEASON_DRIVERTRACKER: "OFFSEASON_DRIVERTRACKER",
  OFFSEASON_MIDSEASONWINDOW: "OFFSEASON_MIDSEASONWINDOW",
  OFFSEASON_WINNINGS: "OFFSEASON_WINNINGS",
};

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { keys, itemTypes, slugify };
