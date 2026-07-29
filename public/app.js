// Calore 1 campaign tracker — vanilla JS, no build step.

let DATA = null;
let MAX_UPGRADE_SLOTS = 3;
let activeTab = "standings";
let saveTimer = null;

const CAR_COLORS = {
  Silver: "#c9cdd3",
  Black: "#3a3a3a",
  Blue: "#3a7bd5",
  Green: "#3ba55d",
  Yellow: "#e8c547",
  Purple: "#8e5bd8",
  Orange: "#e8823c",
  Red: "#e05353",
};

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return "$" + new Intl.NumberFormat("en-US").format(n);
}

// ---------- editable field helpers ----------
function textInput(value, onChange) {
  const inp = h("input", { type: "text" });
  inp.value = value ?? "";
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

function numberInput(value, onChange) {
  const inp = h("input", { type: "number" });
  inp.value = value ?? "";
  inp.addEventListener("change", () => onChange(inp.value === "" ? null : Number(inp.value)));
  return inp;
}

function textareaInput(value, onChange, rows = 3) {
  const ta = h("textarea", { rows: String(rows) });
  ta.value = value ?? "";
  ta.addEventListener("change", () => onChange(ta.value));
  return ta;
}

function selectInput(value, options, onChange) {
  const sel = h("select");
  for (const opt of options) {
    const optVal = typeof opt === "string" ? opt : opt.value;
    const optLabel = typeof opt === "string" ? opt : opt.label;
    const o = h("option", { value: optVal }, optLabel);
    if (optVal === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function upgradeSelect(value, onChange) {
  const sel = h("select");
  sel.appendChild(h("option", { value: "" }, "— none —"));
  const groups = {};
  for (const u of DATA.inventory.upgrades) {
    (groups[u.type] ||= []).push(u);
  }
  for (const [type, list] of Object.entries(groups)) {
    const og = h("optgroup", { label: type });
    for (const u of list) {
      const label = `#${u.partNumber} · ${u.tier} · ${typeof u.cost === "number" ? fmtMoney(u.cost) : u.cost}`;
      const o = h("option", { value: String(u.partNumber) }, label);
      if (value != null && String(u.partNumber) === String(value)) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.addEventListener("change", () => onChange(sel.value === "" ? null : Number(sel.value)));
  return sel;
}

function labeledField(label, inputEl) {
  const wrap = h("div", { style: "flex:1;" });
  wrap.appendChild(h("label", { style: "display:block;font-size:0.75rem;color:var(--text-dim);margin-bottom:4px;" }, label));
  wrap.appendChild(inputEl);
  return wrap;
}

// ---------- driver color helpers ----------
function driverColorFor(driverName) {
  const d = DATA.drivers.find((d) => d.driver === driverName);
  return d ? CAR_COLORS[d.carColor] || null : null;
}

function colorSwatch(color) {
  const dot = h("span", { class: "color-swatch" });
  dot.style.margin = "0";
  dot.style.flex = "none";
  dot.style.background = color || "transparent";
  dot.style.borderColor = color ? "rgba(255,255,255,0.3)" : "var(--border)";
  if (!color) dot.style.borderStyle = "dashed";
  return dot;
}

// Plain-text driver name with a dot in that driver's car color — used
// wherever the name is derived/read-only (Standings, Upgrade Tracker, the
// fixed FICC proposal rows).
function driverBadge(name) {
  const span = h("span", { style: "display:inline-flex; align-items:center; gap:6px;" });
  span.appendChild(colorSwatch(driverColorFor(name)));
  span.appendChild(document.createTextNode(name || ""));
  return span;
}

// Editable driver <select> with the same color dot, kept in sync as the
// selection changes — used in the freeform tracker tables.
function driverSelectField(value, onChange) {
  const wrap = h("div", { style: "display:flex; align-items:center; gap:6px;" });
  const dot = colorSwatch(driverColorFor(value));
  const sel = selectInput(value, ["", ...DATA.drivers.map((d) => d.driver)], (v) => {
    const color = driverColorFor(v);
    dot.style.background = color || "transparent";
    dot.style.borderColor = color ? "rgba(255,255,255,0.3)" : "var(--border)";
    dot.style.borderStyle = color ? "solid" : "dashed";
    onChange(v);
  });
  wrap.appendChild(dot);
  wrap.appendChild(sel);
  return wrap;
}

// ---------- save pipeline ----------
function setSaveState(state) {
  const elS = document.getElementById("save-state");
  elS.classList.remove("saving", "saved", "error");
  if (state === "saving") { elS.textContent = "Saving…"; elS.classList.add("saving"); }
  else if (state === "saved") { elS.textContent = "Saved"; elS.classList.add("saved"); }
  else if (state === "error") { elS.textContent = "Save failed — retrying…"; elS.classList.add("error"); }
}

async function doSave() {
  saveTimer = null;
  setSaveState("saving");
  try {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(DATA),
    });
    if (!res.ok) throw new Error("save failed");
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
    saveTimer = setTimeout(doSave, 2000);
  }
}

function markDirty() {
  setSaveState("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 600);
}

window.addEventListener("beforeunload", (e) => {
  if (saveTimer) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- generic add/delete tracker table ----------
function genericTrackerPanel(title, arr, columns, makeEmptyRow) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, title));
  if (arr.length === 0) {
    panel.appendChild(h("p", { class: "muted" }, "No entries yet — add one below as it happens during the campaign."));
  }
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", {}, c.label)), h("th", {}))));
  const tbody = h("tbody");
  arr.forEach((row, i) => {
    const tr = h("tr");
    columns.forEach((c) => {
      const td = h("td");
      const val = row[c.key];
      if (c.type === "select" && c.key === "driver") {
        td.appendChild(driverSelectField(val, (v) => { row[c.key] = v || null; markDirty(); }));
      } else if (c.type === "select") {
        td.appendChild(selectInput(val, ["", ...c.options()], (v) => { row[c.key] = v || null; markDirty(); }));
      } else if (c.type === "number") {
        td.appendChild(numberInput(val, (v) => { row[c.key] = v; markDirty(); }));
      } else {
        td.appendChild(textInput(val, (v) => { row[c.key] = v; markDirty(); }));
      }
      tr.appendChild(td);
    });
    const tdDel = h("td");
    const delBtn = h("button", { class: "btn small" }, "✕");
    delBtn.addEventListener("click", () => { arr.splice(i, 1); markDirty(); renderActive(); });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  const addBtn = h("button", { class: "btn" }, "+ Add row");
  addBtn.addEventListener("click", () => { arr.push(makeEmptyRow()); markDirty(); renderActive(); });
  panel.appendChild(addBtn);
  return panel;
}

// ---------- Standings ----------
function recomputeStandings() {
  const lookup = {};
  for (const p of DATA.standings.pointsTable) lookup[p.position] = p.points;
  DATA.standings.drivers.forEach((d, i) => {
    d.driver = DATA.drivers[i]?.driver ?? d.driver;
    d.team = DATA.drivers[i]?.teamName ?? d.team;
    let total = 0;
    for (const pos of d.races) {
      if (pos != null && lookup[pos] != null) total += lookup[pos];
    }
    d.totalPoints = total;
  });
  const sorted = [...DATA.standings.drivers].sort((a, b) => b.totalPoints - a.totalPoints);
  let rank = 0, prevPoints = null, seen = 0;
  for (const d of sorted) {
    seen++;
    if (d.totalPoints !== prevPoints) { rank = seen; prevPoints = d.totalPoints; }
    d.position = rank;
  }
}

function renderStandings(container) {
  recomputeStandings();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Driver's Championship — " + (DATA.lore.driversTrophy.name || "")));
  const wrap = h("div", { class: "table-scroll" });
  const table = h("table");
  const labels = DATA.standings.raceLabels;
  table.appendChild(h("thead", {}, h("tr", {},
    h("th", {}, "Driver"), h("th", {}, "Team"),
    ...labels.map((l, i) => h("th", {}, l || `Race ${i + 1}`)),
    h("th", {}, "Total"), h("th", {}, "Pos"))));
  const tbody = h("tbody");
  for (const d of DATA.standings.drivers) {
    const tr = h("tr");
    tr.appendChild(h("td", {}, driverBadge(d.driver)));
    tr.appendChild(h("td", {}, d.team));
    d.races.forEach((val, i) => {
      const td = h("td");
      td.appendChild(numberInput(val, (v) => { d.races[i] = v; recomputeStandings(); renderActive(); markDirty(); }));
      tr.appendChild(td);
    });
    tr.appendChild(h("td", { class: "cell-computed" }, String(d.totalPoints)));
    tr.appendChild(h("td", { class: "cell-computed pos-" + d.position }, String(d.position)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  const details = h("details");
  details.appendChild(h("summary", {}, "Points-per-position lookup table (edit to change scoring rules)"));
  const table2 = h("table");
  table2.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Position"), h("th", {}, "Points"))));
  const tbody2 = h("tbody");
  DATA.standings.pointsTable.forEach((row) => {
    const tr = h("tr");
    const tdPos = h("td"); tdPos.appendChild(numberInput(row.position, (v) => { row.position = v; recomputeStandings(); renderActive(); markDirty(); }));
    const tdPts = h("td"); tdPts.appendChild(numberInput(row.points, (v) => { row.points = v; recomputeStandings(); renderActive(); markDirty(); }));
    tr.appendChild(tdPos); tr.appendChild(tdPts);
    tbody2.appendChild(tr);
  });
  table2.appendChild(tbody2);
  details.appendChild(table2);
  panel2.appendChild(details);
  container.appendChild(panel2);
}

// ---------- Drivers ----------
function renderDrivers(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "1961 Driver Lineup"));
  const grid = h("div", { class: "driver-grid" });
  DATA.drivers.forEach((d) => {
    const card = h("div", { class: "driver-card" });
    card.style.setProperty("--car-color", CAR_COLORS[d.carColor] || "#888");

    const teamInput = textInput(d.teamName, (v) => { d.teamName = v; markDirty(); });
    teamInput.classList.add("team-name-input");
    teamInput.style.fontWeight = "700";
    teamInput.style.fontSize = "1.05rem";
    teamInput.style.marginBottom = "8px";
    card.appendChild(teamInput);

    const row = h("div", { style: "display:flex; gap:8px; margin-bottom:8px;" });
    row.appendChild(labeledField("Driver", textInput(d.driver, (v) => { d.driver = v; markDirty(); })));
    row.appendChild(labeledField("Player", textInput(d.player, (v) => { d.player = v; markDirty(); })));
    card.appendChild(row);

    card.appendChild(labeledField("Car Color", selectInput(d.carColor, Object.keys(CAR_COLORS), (v) => { d.carColor = v; markDirty(); renderActive(); })));

    const details = h("details");
    details.appendChild(h("summary", {}, "Backstory"));
    details.appendChild(textareaInput(d.backstory, (v) => { d.backstory = v; markDirty(); }, 6));
    card.appendChild(details);

    grid.appendChild(card);
  });
  panel.appendChild(grid);
  container.appendChild(panel);
}

// ---------- Upgrade Tracker ----------
function computeUpgradeCost(partNumber) {
  const u = DATA.inventory.upgrades.find((u) => u.partNumber === Number(partNumber));
  if (!u) return 0;
  return typeof u.cost === "number" ? u.cost : 0;
}

function computeSponsorFunding(sponsorName) {
  if (!sponsorName) return 0;
  const s = DATA.inventory.sponsors.find((s) => s.name === sponsorName);
  return s && typeof s.funding === "number" ? s.funding : 0;
}

// Mirrors the sheet's formulas: Driver is INDEX'd from DriverLineup by row,
// Budget = base team budget + sponsor funding + modification (all derived,
// not directly editable), Remaining = Budget - sum(selected upgrade costs).
function recomputeUpgradeTracker() {
  DATA.upgradeTracker.entries.forEach((e, i) => {
    e.driver = DATA.drivers[i]?.driver ?? e.driver;
    e.budget = (DATA.season.baseTeamBudget || 0) + computeSponsorFunding(e.sponsor) + (e.modification || 0);
    const spent = e.upgrades.reduce((sum, p) => sum + (p != null ? computeUpgradeCost(p) : 0), 0);
    e.remainingBudget = e.budget - spent;
  });
}

function renderUpgradeTracker(container) {
  recomputeUpgradeTracker();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Upgrade Tracker — Current Season"));
  if (DATA.upgradeTracker.rule) panel.appendChild(h("p", { class: "muted panel-note" }, DATA.upgradeTracker.rule));
  const wrap = h("div", { class: "table-scroll" });
  const table = h("table");
  const headRow = h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Sponsor"), h("th", {}, "Budget"));
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) headRow.appendChild(h("th", {}, `Upgrade ${i + 1}`));
  headRow.appendChild(h("th", {}, "Modification"));
  headRow.appendChild(h("th", {}, "Remaining"));
  table.appendChild(h("thead", {}, headRow));
  const tbody = h("tbody");
  const sponsorNames = DATA.inventory.sponsors.map((s) => s.name);
  for (const e of DATA.upgradeTracker.entries) {
    const tr = h("tr");
    tr.appendChild(h("td", {}, driverBadge(e.driver)));
    const sponsorTd = h("td");
    sponsorTd.appendChild(selectInput(e.sponsor, ["", ...sponsorNames], (v) => { e.sponsor = v || null; recomputeUpgradeTracker(); renderActive(); markDirty(); }));
    tr.appendChild(sponsorTd);
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.budget)));
    e.upgrades.forEach((val, i) => {
      const td = h("td");
      td.appendChild(upgradeSelect(val, (v) => { e.upgrades[i] = v; recomputeUpgradeTracker(); renderActive(); markDirty(); }));
      tr.appendChild(td);
    });
    const modTd = h("td");
    modTd.appendChild(numberInput(e.modification, (v) => { e.modification = v; recomputeUpgradeTracker(); renderActive(); markDirty(); }));
    tr.appendChild(modTd);
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.remainingBudget)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  container.appendChild(panel);
}

// ---------- Inventory ----------
const invFilter = { search: "", type: "", tier: "" };

function renderInventoryTableInto(holder) {
  holder.innerHTML = "";
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Type"), h("th", {}, "Part #"), h("th", {}, "Effect"), h("th", {}, "Count"), h("th", {}, "Tier"), h("th", {}, "Cost"))));
  const tbody = h("tbody");
  const filtered = DATA.inventory.upgrades.filter((u) => {
    if (invFilter.type && u.type !== invFilter.type) return false;
    if (invFilter.tier && String(u.tier) !== invFilter.tier) return false;
    if (invFilter.search) {
      const s = invFilter.search.toLowerCase();
      if (!(String(u.type).toLowerCase().includes(s) || String(u.effect || "").toLowerCase().includes(s))) return false;
    }
    return true;
  });
  for (const u of filtered) {
    const tr = h("tr");
    const tdType = h("td"); tdType.appendChild(textInput(u.type, (v) => { u.type = v; markDirty(); }));
    tr.appendChild(tdType);
    tr.appendChild(h("td", { class: "cell-computed" }, String(u.partNumber)));
    const tdEffect = h("td"); tdEffect.appendChild(textInput(u.effect, (v) => { u.effect = v; markDirty(); }));
    tr.appendChild(tdEffect);
    const tdCount = h("td"); tdCount.appendChild(numberInput(u.countAvailable, (v) => { u.countAvailable = v; markDirty(); }));
    tr.appendChild(tdCount);
    const tdTier = h("td");
    const tierInput = textInput(u.tier, (v) => { u.tier = v; markDirty(); renderInventoryTableInto(holder); });
    tierInput.classList.add("tier-" + u.tier);
    tdTier.appendChild(tierInput);
    tr.appendChild(tdTier);
    const tdCost = h("td"); tdCost.appendChild(numberInput(typeof u.cost === "number" ? u.cost : null, (v) => { u.cost = v; markDirty(); }));
    tr.appendChild(tdCost);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  holder.appendChild(table);
}

function renderInventory(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Upgrade Parts Inventory"));
  const types = [...new Set(DATA.inventory.upgrades.map((u) => u.type))].sort();
  const tiers = [...new Set(DATA.inventory.upgrades.map((u) => String(u.tier)))].sort();
  const filters = h("div", { class: "filters" });
  const searchInp = h("input", { type: "text", placeholder: "Search type or effect…" });
  searchInp.value = invFilter.search;
  searchInp.addEventListener("input", () => { invFilter.search = searchInp.value; renderInventoryTableInto(holder); });
  const typeSel = selectInput(invFilter.type, ["All", ...types], (v) => { invFilter.type = v; renderInventoryTableInto(holder); });
  const tierSel = selectInput(invFilter.tier, ["All", ...tiers], (v) => { invFilter.tier = v; renderInventoryTableInto(holder); });
  filters.appendChild(searchInp); filters.appendChild(typeSel); filters.appendChild(tierSel);
  panel.appendChild(filters);
  const holder = h("div", { class: "table-scroll" });
  panel.appendChild(holder);
  container.appendChild(panel);
  renderInventoryTableInto(holder);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Sponsors"));
  const table2 = h("table");
  table2.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Count"), h("th", {}, "Funding"))));
  const tbody2 = h("tbody");
  DATA.inventory.sponsors.forEach((s) => {
    const tr = h("tr");
    const tdName = h("td"); tdName.appendChild(textInput(s.name, (v) => { s.name = v; markDirty(); }));
    const tdType = h("td"); tdType.appendChild(textInput(s.type, (v) => { s.type = v; markDirty(); }));
    const tdCount = h("td"); tdCount.appendChild(numberInput(s.countAvailable, (v) => { s.countAvailable = v; markDirty(); }));
    const tdFund = h("td"); tdFund.appendChild(numberInput(s.funding, (v) => { s.funding = v; markDirty(); }));
    tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdCount); tr.appendChild(tdFund);
    tbody2.appendChild(tr);
  });
  table2.appendChild(tbody2);
  panel2.appendChild(table2);
  container.appendChild(panel2);
}

// ---------- Season & Schedule ----------
function renderSeason(container) {
  const s = DATA.season;
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Season Information"));
  const kv = h("div", { class: "kv-grid" });
  const addKV = (label, inputEl) => { kv.appendChild(h("label", {}, label)); kv.appendChild(inputEl); };
  addKV("Season number", numberInput(s.seasonNumber, (v) => { s.seasonNumber = v; markDirty(); }));
  addKV("Races this season", numberInput(s.racesThisSeason, (v) => { s.racesThisSeason = v; markDirty(); }));
  addKV("Upgrade slots this season", numberInput(s.upgradeSlots, (v) => { s.upgradeSlots = v; markDirty(); }));
  addKV("Track selection method", textInput(s.trackSelectionMethod, (v) => { s.trackSelectionMethod = v; markDirty(); }));
  addKV("Mid-season break after race #", numberInput(s.midSeasonBreakAfterRace, (v) => { s.midSeasonBreakAfterRace = v; markDirty(); }));
  addKV("Legends enabled", selectInput(s.legends, ["Yes", "No"], (v) => { s.legends = v; markDirty(); }));
  addKV("Base team budget", numberInput(s.baseTeamBudget, (v) => { s.baseTeamBudget = v; markDirty(); }));
  panel.appendChild(kv);
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Race Schedule"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Race #"), h("th", {}, "Track"), h("th", {}, ""))));
  const tbody = h("tbody");
  s.schedule.forEach((r, i) => {
    const tr = h("tr");
    const tdNum = h("td"); tdNum.appendChild(numberInput(r.race, (v) => { r.race = v; markDirty(); }));
    const tdTrack = h("td"); tdTrack.appendChild(textInput(r.track, (v) => { r.track = v; markDirty(); }));
    const tdDel = h("td");
    const delBtn = h("button", { class: "btn small" }, "✕");
    delBtn.addEventListener("click", () => { s.schedule.splice(i, 1); markDirty(); renderActive(); });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdNum); tr.appendChild(tdTrack); tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel2.appendChild(table);
  const addBtn = h("button", { class: "btn" }, "+ Add race");
  addBtn.addEventListener("click", () => {
    const nextNum = (s.schedule.at(-1)?.race || 0) + 1;
    s.schedule.push({ race: nextNum, track: "" });
    markDirty(); renderActive();
  });
  panel2.appendChild(addBtn);
  container.appendChild(panel2);
}

// ---------- Technical Regulations ----------
function renderTechRegs(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "1961 Technical Regulations"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Regulation"), h("th", {}, "Type"), h("th", {}, "Explanation"), h("th", {}, "Expiration"), h("th", {}, ""))));
  const tbody = h("tbody");
  DATA.technicalRegulations.forEach((r, i) => {
    const tr = h("tr");
    const tdName = h("td"); tdName.appendChild(textInput(r.name, (v) => { r.name = v; markDirty(); }));
    const tdType = h("td"); tdType.appendChild(textInput(r.type, (v) => { r.type = v; markDirty(); }));
    const tdExp = h("td"); tdExp.appendChild(textareaInput(r.explanation, (v) => { r.explanation = v; markDirty(); }, 2));
    const tdExpr = h("td"); tdExpr.appendChild(textInput(r.expiration, (v) => { r.expiration = v; markDirty(); }));
    const tdDel = h("td");
    const b = h("button", { class: "btn small" }, "✕");
    b.addEventListener("click", () => { DATA.technicalRegulations.splice(i, 1); markDirty(); renderActive(); });
    tdDel.appendChild(b);
    tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdExp); tr.appendChild(tdExpr); tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  const addBtn = h("button", { class: "btn" }, "+ Add regulation");
  addBtn.addEventListener("click", () => { DATA.technicalRegulations.push({ name: "", type: "", explanation: "", expiration: "" }); markDirty(); renderActive(); });
  panel.appendChild(addBtn);
  container.appendChild(panel);
}

// ---------- FICC Backlog ----------
function renderFiccBacklog(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "FICC Rules Backlog"));
  DATA.ficcBacklog.notes.forEach((note, i) => {
    panel.appendChild(textareaInput(note, (v) => { DATA.ficcBacklog.notes[i] = v; markDirty(); }, 2));
  });
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Proposed Regulations"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Proposed Regulation"), h("th", {}, "Type"), h("th", {}, "Explanation"), h("th", {}, "Expiration"), h("th", {}, ""))));
  const tbody = h("tbody");
  // The first N proposal rows are INDEX'd from the driver lineup in the sheet
  // (one proposal slot per driver) — Driver there is derived, not a free pick.
  const driverRowCount = DATA.drivers.length;
  DATA.ficcBacklog.proposals.forEach((p, i) => {
    if (i < driverRowCount) p.driverName = DATA.drivers[i]?.driver ?? p.driverName;
    const tr = h("tr");
    const tdDriver = h("td");
    if (i < driverRowCount) {
      tdDriver.appendChild(driverBadge(p.driverName));
    } else {
      tdDriver.appendChild(driverSelectField(p.driverName, (v) => { p.driverName = v || null; markDirty(); }));
    }
    const tdReg = h("td"); tdReg.appendChild(textInput(p.regulationName, (v) => { p.regulationName = v; markDirty(); }));
    const tdType = h("td"); tdType.appendChild(textInput(p.type, (v) => { p.type = v; markDirty(); }));
    const tdExp = h("td"); tdExp.appendChild(textareaInput(p.explanation, (v) => { p.explanation = v; markDirty(); }, 2));
    const tdExpr = h("td"); tdExpr.appendChild(textInput(p.expiration, (v) => { p.expiration = v; markDirty(); }));
    const tdDel = h("td");
    if (i >= driverRowCount) {
      const b = h("button", { class: "btn small" }, "✕");
      b.addEventListener("click", () => { DATA.ficcBacklog.proposals.splice(i, 1); markDirty(); renderActive(); });
      tdDel.appendChild(b);
    }
    tr.appendChild(tdDriver); tr.appendChild(tdReg); tr.appendChild(tdType); tr.appendChild(tdExp); tr.appendChild(tdExpr); tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel2.appendChild(table);
  const addBtn = h("button", { class: "btn" }, "+ Add proposal");
  addBtn.addEventListener("click", () => { DATA.ficcBacklog.proposals.push({ driverName: null, regulationName: "", type: "", explanation: "", expiration: "" }); markDirty(); renderActive(); });
  panel2.appendChild(addBtn);
  container.appendChild(panel2);
}

// ---------- Off-Season Budget ----------
function renderOffSeason(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Off-Season Upgrade Budget — Catch-up System"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Tier"), h("th", {}, "Upgrade Exchange"), h("th", {}, "Heat Cards"), h("th", {}, "Winnings"))));
  const tbody = h("tbody");
  DATA.offSeasonBudget.regulations.forEach((r) => {
    const tr = h("tr");
    const tdTier = h("td"); tdTier.appendChild(textInput(r.tier, (v) => { r.tier = v; markDirty(); }));
    const tdEx = h("td"); tdEx.appendChild(textInput(r.upgradeExchange, (v) => { r.upgradeExchange = v; markDirty(); }));
    const tdHeat = h("td"); tdHeat.appendChild(textInput(r.heatCards, (v) => { r.heatCards = v; markDirty(); }));
    const tdWin = h("td"); tdWin.appendChild(textareaInput(String(r.winnings ?? ""), (v) => { r.winnings = v; markDirty(); }, 2));
    tr.appendChild(tdTier); tr.appendChild(tdEx); tr.appendChild(tdHeat); tr.appendChild(tdWin);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  container.appendChild(panel);

  container.appendChild(genericTrackerPanel(
    "Driver Off-Season Tracker",
    DATA.offSeasonBudget.driverTracker,
    [
      { key: "driver", label: "Driver", type: "select", options: () => DATA.drivers.map((d) => d.driver) },
      { key: "upgradeOut", label: "Upgrade Exchanged Out" },
      { key: "upgradeIn", label: "Upgrade Exchanged In" },
      { key: "heatCardsReceived", label: "Heat Cards Received" },
      { key: "winningsReceived", label: "Winnings Received", type: "number" },
      { key: "note", label: "Note" },
    ],
    () => ({ driver: null, upgradeOut: "", upgradeIn: "", heatCardsReceived: "", winningsReceived: null, note: "" })
  ));

  container.appendChild(genericTrackerPanel(
    "Mid-Season Upgrade Window",
    DATA.offSeasonBudget.midSeasonWindow,
    [
      { key: "driver", label: "Driver", type: "select", options: () => DATA.drivers.map((d) => d.driver) },
      { key: "upgradeOut", label: "Upgrade Swapped Out" },
      { key: "upgradeIn", label: "Upgrade Swapped In" },
      { key: "note", label: "Note" },
    ],
    () => ({ driver: null, upgradeOut: "", upgradeIn: "", note: "" })
  ));
}

// ---------- Hall of Fame ----------
function renderHallOfFame(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Season-by-Season Champion Log"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Season"), h("th", {}, "Driver's Champion"), h("th", {}, "Constructor's Champion"))));
  const tbody = h("tbody");
  DATA.hallOfFame.seasonLog.forEach((row) => {
    const tr = h("tr");
    tr.appendChild(h("td", { class: "cell-computed" }, String(row.season)));
    const tdChamp = h("td"); tdChamp.appendChild(textInput(row.champion, (v) => { row.champion = v; markDirty(); }));
    const tdCons = h("td"); tdCons.appendChild(textInput(row.constructorChampion, (v) => { row.constructorChampion = v; markDirty(); }));
    tr.appendChild(tdChamp); tr.appendChild(tdCons);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  const addBtn = h("button", { class: "btn" }, "+ Add season");
  addBtn.addEventListener("click", () => {
    const next = (DATA.hallOfFame.seasonLog.at(-1)?.season || 0) + 1;
    DATA.hallOfFame.seasonLog.push({ season: next, champion: null, constructorChampion: null });
    markDirty(); renderActive();
  });
  panel.appendChild(addBtn);
  container.appendChild(panel);

  container.appendChild(genericTrackerPanel(
    "Missed Race Log",
    DATA.hallOfFame.missedRaceLog,
    [
      { key: "season", label: "Season", type: "number" },
      { key: "race", label: "Race" },
      { key: "driver", label: "Driver", type: "select", options: () => DATA.drivers.map((d) => d.driver) },
      { key: "legendSub", label: "Legend Substitute" },
      { key: "pointsEarned", label: "Points Earned", type: "number" },
      { key: "note", label: "Note" },
    ],
    () => ({ season: DATA.season.seasonNumber, race: "", driver: null, legendSub: "", pointsEarned: null, note: "" })
  ));
}

// ---------- Lore ----------
function renderLore(container) {
  const l = DATA.lore;
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "League"));
  const kv = h("div", { class: "kv-grid" });
  const addKV = (label, inputEl) => { kv.appendChild(h("label", {}, label)); kv.appendChild(inputEl); };
  addKV("League name", textInput(l.leagueName, (v) => { l.leagueName = v; markDirty(); document.getElementById("league-name").textContent = v; }));
  addKV("Governing body", textInput(l.governingBody, (v) => { l.governingBody = v; markDirty(); }));
  addKV("Founded", textareaInput(l.founded, (v) => { l.founded = v; markDirty(); }, 2));
  addKV("Motto", textInput(l.motto, (v) => { l.motto = v; markDirty(); }));
  panel.appendChild(kv);
  container.appendChild(panel);

  const mkTrophyBlock = (title, trophy) => {
    const block = h("div", { class: "panel lore-block" });
    block.appendChild(h("h2", {}, title));
    block.appendChild(labeledField("Trophy name", textInput(trophy.name, (v) => { trophy.name = v; markDirty(); })));
    block.appendChild(labeledField("Awarded to", textInput(trophy.awardedTo, (v) => { trophy.awardedTo = v; markDirty(); })));
    block.appendChild(labeledField(`About ${trophy.aboutPerson || ""}`, textareaInput(trophy.about, (v) => { trophy.about = v; markDirty(); }, 10)));
    return block;
  };
  container.appendChild(mkTrophyBlock("Driver's Trophy", l.driversTrophy));
  container.appendChild(mkTrophyBlock("Constructor's Trophy", l.constructorsTrophy));

  const panel3 = h("div", { class: "panel" });
  panel3.appendChild(h("h2", {}, "Backstory Note"));
  panel3.appendChild(textareaInput(l.backstoryNote, (v) => { l.backstoryNote = v; markDirty(); }, 4));
  container.appendChild(panel3);
}

// ---------- tabs infra ----------
const TABS = [
  { id: "standings", label: "Standings", render: renderStandings },
  { id: "drivers", label: "Drivers", render: renderDrivers },
  { id: "upgrades", label: "Upgrade Tracker", render: renderUpgradeTracker },
  { id: "inventory", label: "Inventory", render: renderInventory },
  { id: "season", label: "Season & Schedule", render: renderSeason },
  { id: "techregs", label: "Technical Regs", render: renderTechRegs },
  { id: "ficc", label: "FICC Backlog", render: renderFiccBacklog },
  { id: "offseason", label: "Off-Season Budget", render: renderOffSeason },
  { id: "hof", label: "Hall of Fame", render: renderHallOfFame },
  { id: "lore", label: "Lore & Trophies", render: renderLore },
];

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  for (const t of TABS) {
    const btn = h("button", { class: "tab-btn" + (t.id === activeTab ? " active" : "") }, t.label);
    btn.addEventListener("click", () => { activeTab = t.id; renderTabs(); renderActive(); });
    nav.appendChild(btn);
  }
}

function renderActive() {
  const content = document.getElementById("tab-content");
  content.innerHTML = "";
  const tab = TABS.find((t) => t.id === activeTab);
  tab.render(content);
}

function normalizeData() {
  MAX_UPGRADE_SLOTS = Math.max(DATA.season.upgradeSlots || 0, 3, ...DATA.upgradeTracker.entries.map((e) => e.upgrades.length));
  for (const e of DATA.upgradeTracker.entries) {
    while (e.upgrades.length < MAX_UPGRADE_SLOTS) e.upgrades.push(null);
  }
}

async function init() {
  const res = await fetch("/api/data");
  DATA = await res.json();
  normalizeData();
  document.getElementById("league-name").textContent = DATA.lore.leagueName || "Calore 1";
  document.getElementById("league-sub").textContent = `${DATA.lore.governingBody || ""} — Season ${DATA.season.seasonNumber}`;
  setSaveState("saved");
  document.getElementById("save-now-btn").addEventListener("click", () => { clearTimeout(saveTimer); doSave(); });
  renderTabs();
  renderActive();
}

init();
