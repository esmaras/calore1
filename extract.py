#!/usr/bin/env python3
"""Regenerates data.json from calore_1_heat_campaign.xlsx.

Run this any time you re-export a fresh copy of the spreadsheet and want
to reset the web app's data back to the spreadsheet's contents. Note that
edits made in the web app are saved to data.json directly and will be
overwritten if you re-run this script.
"""
import json
import openpyxl

SRC = "calore_1_heat_campaign.xlsx"
OUT = "data.json"

wb = openpyxl.load_workbook(SRC, data_only=True)


def rows(name):
    ws = wb[name]
    return [list(r) for r in ws.iter_rows(values_only=True)]


def clean_num(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


# ---------- Trophies & Lore ----------
lore_rows = rows("Trophies & Lore")
lore_map = {r[0]: r[1] for r in lore_rows[1:] if r[0]}
lore = {
    "leagueName": lore_map.get("LEAGUE NAME"),
    "governingBody": lore_map.get("GOVERNING BODY"),
    "founded": lore_map.get("FOUNDED"),
    "motto": lore_map.get("LEAGUE MOTTO"),
    "driversTrophy": {
        "name": lore_map.get("DRIVER'S TROPHY"),
        "aboutPerson": "Axle Carbone",
        "about": lore_map.get("ABOUT AXLE CARBONE"),
    },
    "constructorsTrophy": {
        "name": lore_map.get("CONSTRUCTOR'S TROPHY"),
        "aboutPerson": "Lucca Pistone",
        "about": lore_map.get("ABOUT LUCCA PISTONE"),
    },
    "backstoryNote": lore_map.get("BACKSTORY NOTE"),
}
# awarded-to lines sit as duplicate 'AWARDED TO' keys so grab positionally
awarded = [r[1] for r in lore_rows if r and r[0] == "AWARDED TO"]
if len(awarded) >= 2:
    lore["driversTrophy"]["awardedTo"] = awarded[0]
    lore["constructorsTrophy"]["awardedTo"] = awarded[1]

# ---------- Driver Lineup ----------
dl_rows = rows("1961 Driver Lineup")
drivers = []
for r in dl_rows[1:]:
    if not r[0]:
        continue
    drivers.append({
        "player": r[0],
        "driver": r[1],
        "carColor": r[2],
        "teamName": r[3],
        "backstory": r[4],
    })

# ---------- Season Overview ----------
so_rows = rows("1961 Season Overview")
season_info = {}
schedule = []
mode = None
for r in so_rows[1:]:
    if r[0] == "RACE SCHEDULE":
        mode = "schedule"
        continue
    if r[0] == "Race #":
        continue
    if mode == "schedule":
        if r[0] is None:
            continue
        schedule.append({"race": clean_num(r[0]), "track": r[1]})
    else:
        if r[0] is None:
            continue
        season_info[r[0]] = clean_num(r[1])

season = {
    "seasonNumber": clean_num(season_info.get("Season number")),
    "racesThisSeason": clean_num(season_info.get("Races this season")),
    "upgradeSlots": clean_num(season_info.get("Upgrade slots this season")),
    "trackSelectionMethod": season_info.get("Track selection method"),
    "midSeasonBreakAfterRace": clean_num(season_info.get("Mid-season break after race #")),
    "legends": season_info.get("Legends"),
    "baseTeamBudget": clean_num(season_info.get("Base Team Budget")),
    "schedule": schedule,
}

# ---------- Technical Regulations ----------
tr_rows = rows("1961 Technical Regulations")
tech_regs = []
for r in tr_rows[1:]:
    if not r[0]:
        continue
    tech_regs.append({
        "name": r[0],
        "type": r[1],
        "explanation": r[2],
        "expiration": r[3],
    })

# ---------- FICC Backlog ----------
fb_rows = rows("FICC Backlog")
notes = [r[0] for r in fb_rows[1:4] if r[0]]
proposals = []
for r in fb_rows[5:]:
    if all(c is None for c in r):
        continue
    proposals.append({
        "driverName": r[0],
        "regulationName": r[1],
        "type": r[2],
        "explanation": r[3],
        "expiration": r[4],
    })
ficc_backlog = {"notes": notes, "proposals": proposals}

# ---------- Championship Standings ----------
cs_rows = rows("1961 Championship Standings")
header_idx = next(i for i, r in enumerate(cs_rows) if r[0] == "Driver")
race_cols = cs_rows[header_idx][2:6]
standings_drivers = []
i = header_idx + 1
while i < len(cs_rows) and cs_rows[i][0]:
    r = cs_rows[i]
    standings_drivers.append({
        "driver": r[0],
        "team": r[1],
        "races": [clean_num(v) for v in r[2:6]],
        "totalPoints": clean_num(r[6]),
        "position": clean_num(r[7]),
    })
    i += 1

pt_header_idx = next(i for i, r in enumerate(cs_rows) if r[0] == "Position")
points_table = []
for r in cs_rows[pt_header_idx + 1:]:
    if r[0] is None:
        continue
    pos = clean_num(r[0])
    if pos == 0:
        continue
    points_table.append({"position": pos, "points": clean_num(r[1])})

standings = {
    "raceLabels": race_cols,
    "drivers": standings_drivers,
    "pointsTable": points_table,
}

# ---------- Inventory ----------
inv_rows = rows("Inventory")
upgrades = []
sponsors = []
section = "upgrades"
for r in inv_rows[1:]:
    if all(c is None for c in r):
        continue
    if r[0] == "Sponsor":
        section = "sponsors"
        continue
    if section == "upgrades":
        upgrades.append({
            "type": r[0],
            "partNumber": clean_num(r[1]),
            "effect": r[2],
            "countAvailable": clean_num(r[3]),
            "tier": r[4],
            "cost": clean_num(r[5]),
        })
    else:
        sponsors.append({
            "name": r[0],
            "type": r[1],
            "countAvailable": clean_num(r[3]),
            "funding": clean_num(r[5]),
        })
inventory = {"upgrades": upgrades, "sponsors": sponsors}

# ---------- Upgrade Tracker ----------
ut_rows = rows("Upgrade Tracker")
rule = ut_rows[1][0]
header_idx = next(i for i, r in enumerate(ut_rows) if r[0] == "Driver")
entries = []
i = header_idx + 1
while i < len(ut_rows) and ut_rows[i][0]:
    r = ut_rows[i]
    entries.append({
        "driver": r[0],
        "sponsor": r[1],
        "budget": clean_num(r[2]),
        "upgrades": [clean_num(v) for v in r[3:10] if v is not None],
        "modification": clean_num(r[10]),
        "remainingBudget": clean_num(r[11]),
    })
    i += 1

legend_idx = next(i for i, r in enumerate(ut_rows) if r[0] == "UPGRADE TYPE LEGEND")
legend = []
for r in ut_rows[legend_idx + 1:]:
    if not r[0]:
        continue
    legend.append({"type": r[0], "description": r[1]})
upgrade_tracker = {"rule": rule, "entries": entries, "legend": legend}

# ---------- Hall of Fame ----------
hof_rows = rows("Hall of Fame")
season_log = []
missed_race_log = []
mode = "season_log"
for r in hof_rows[2:]:
    if all(c is None for c in r):
        continue
    if r[0] == "MISSED RACE LOG":
        mode = "missed"
        continue
    if r[0] == "SEASON-BY-SEASON CHAMPION LOG":
        continue
    if mode == "season_log":
        season_log.append({
            "season": clean_num(r[0]),
            "champion": r[1],
            "constructorChampion": r[2],
        })
    else:
        missed_race_log.append(r)
hall_of_fame = {"seasonLog": season_log, "missedRaceLog": missed_race_log}

# ---------- Off-Season Budget ----------
ob_rows = rows("Off-Season Budget")
regs = []
mode = "regs"
driver_tracker = []
mid_season_window = []
for i, r in enumerate(ob_rows):
    if i < 3:
        continue
    if all(c is None for c in r):
        continue
    if r[0] == "DRIVER OFF-SEASON TRACKER":
        mode = "driver_tracker"
        continue
    if r[0] == "MID-SEASON UPGRADE WINDOW":
        mode = "mid_season"
        continue
    if mode == "regs":
        if not r[0]:
            continue
        regs.append({
            "tier": r[0],
            "upgradeExchange": r[1],
            "heatCards": r[2],
            "winnings": r[3],
        })
    elif mode == "driver_tracker":
        driver_tracker.append(r)
    else:
        mid_season_window.append(r)
off_season_budget = {
    "regulations": regs,
    "driverTracker": driver_tracker,
    "midSeasonWindow": mid_season_window,
}

data = {
    "lore": lore,
    "drivers": drivers,
    "season": season,
    "technicalRegulations": tech_regs,
    "ficcBacklog": ficc_backlog,
    "standings": standings,
    "inventory": inventory,
    "upgradeTracker": upgrade_tracker,
    "hallOfFame": hall_of_fame,
    "offSeasonBudget": off_season_budget,
}

with open(OUT, "w") as f:
    json.dump(data, f, indent=2, default=str)

print(f"Wrote {OUT}")
