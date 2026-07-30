// Calore 1 campaign tracker — vanilla JS, no build step.

let DATA = null;
let MAX_UPGRADE_SLOTS = 3;
let activeTab = "standings";
// The season Standings/Upgrade Tracker/FICC Backlog are currently showing.
// Starts null (server picks the current season on first load); synced to
// DATA.viewedSeasonNumber after every fetch so writes always target the
// season actually on screen, not whatever the server's default happens
// to be if that differs.
let VIEWED_SEASON = null;

function seasonQuery() {
  return VIEWED_SEASON != null ? `?season=${VIEWED_SEASON}` : "";
}

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

// Podium positions (1-3) each get their own color; everything else shares
// one "other" class instead of a numbered class per position, so the CSS
// doesn't need a repeated rule for every possible position value.
function podiumClass(prefix, position) {
  return prefix + (position >= 1 && position <= 3 ? position : "other");
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
// Merges the admin-managed allowed-colors list (DATA.carColors, editable
// via the Inventory tab) over the static fallback map — new colors added
// by an admin show up without any other client change.
function carColorMap() {
  const map = { ...CAR_COLORS };
  for (const c of DATA.carColors || []) map[c.name] = c.hex;
  return map;
}

function driverColorFor(driverName) {
  const d = DATA.drivers.find((d) => d.driver === driverName);
  return d ? carColorMap()[d.carColor] || null : null;
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

// ---------- permissions ----------
function isAdmin() {
  return CURRENT_USER?.role === "admin";
}

function isSelfOrAdmin(driverId) {
  return isAdmin() || (driverId != null && CURRENT_USER?.driverId === driverId);
}

// ---------- save pipeline ----------
// Each editable section saves independently to its own granular endpoint
// (see server/routes/*) rather than one big blob POST — a debounce timer
// per section key, so editing two different sections doesn't cancel each
// other's pending saves.
const saveTimers = new Map(); // key -> { timer, fn }
let pendingSaveCount = 0;

function setSaveState(state) {
  const elS = document.getElementById("save-state");
  elS.classList.remove("saving", "saved", "error");
  if (state === "saving") { elS.textContent = "Saving…"; elS.classList.add("saving"); }
  else if (state === "saved") { elS.textContent = "Saved"; elS.classList.add("saved"); }
  else if (state === "error") { elS.textContent = "Save failed — retrying…"; elS.classList.add("error"); }
}

async function apiRequest(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 401) {
    window.location.reload();
    throw new Error("Session expired");
  }
  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(responseBody.error || `Request failed (${res.status})`);
  return responseBody;
}

function apiGet(url) {
  return apiRequest("GET", url);
}

function apiPut(url, body) {
  return apiRequest("PUT", url, body);
}

function apiPost(url, body) {
  return apiRequest("POST", url, body);
}

async function runSave(key, fn) {
  saveTimers.delete(key);
  pendingSaveCount++;
  try {
    await fn();
    pendingSaveCount = Math.max(0, pendingSaveCount - 1);
  } catch (err) {
    console.error(`Save failed for "${key}":`, err.message);
    setSaveState("error");
    pendingSaveCount = Math.max(0, pendingSaveCount - 1);
    saveTimers.set(key, { timer: setTimeout(() => runSave(key, fn), 2000), fn });
    return;
  }
  if (pendingSaveCount === 0 && saveTimers.size === 0) setSaveState("saved");
}

function scheduleSave(key, fn) {
  setSaveState("saving");
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing.timer);
  saveTimers.set(key, { timer: setTimeout(() => runSave(key, fn), 600), fn });
}

function flushAllSaves() {
  for (const [key, { timer, fn }] of [...saveTimers.entries()]) {
    clearTimeout(timer);
    saveTimers.delete(key);
    runSave(key, fn);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (saveTimers.size > 0 || pendingSaveCount > 0) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- per-section save functions ----------
function saveDriverFields(driverId, fields) {
  scheduleSave(`driver:${driverId}`, () => apiPut(`/api/drivers/${driverId}`, fields));
}

function saveStandingsRow(driverId) {
  const row = DATA.standings.drivers.find((d) => d.driverId === driverId);
  scheduleSave(`standings:${driverId}`, () => apiPut(`/api/standings/${driverId}${seasonQuery()}`, { races: row.races }));
}

function savePointsTable() {
  scheduleSave("points-table", () => apiPut(`/api/standings/points-table${seasonQuery()}`, { pointsTable: DATA.standings.pointsTable }));
}

function saveUpgradeTrackerRow(driverId) {
  const row = DATA.upgradeTracker.entries.find((e) => e.driverId === driverId);
  scheduleSave(`upgrade-tracker:${driverId}`, () =>
    apiPut(`/api/upgrade-tracker/${driverId}${seasonQuery()}`, { sponsor: row.sponsor, upgrades: row.upgrades, modification: row.modification })
  );
}

function saveUpgradeLegend() {
  scheduleSave("upgrade-legend", () => apiPut("/api/upgrade-tracker/legend", { legend: DATA.upgradeTracker.legend, rule: DATA.upgradeTracker.rule }));
}

function saveLoreField(fields) {
  scheduleSave("lore", () => apiPut("/api/lore", fields));
}

// Targets whichever season is currently being viewed — the Season &
// Schedule tab always edits VIEWED_SEASON, same as every other
// season-scoped tab.
function saveSeasonField(fields) {
  scheduleSave("season", () => apiPut(`/api/season/${VIEWED_SEASON}`, fields));
}

function createSeason(label) {
  return apiPost("/api/season", { label });
}

function setCurrentSeason(seasonNumber) {
  return apiPost(`/api/season/${seasonNumber}/set-current`);
}

function saveTechRegs() {
  scheduleSave("techregs", () => apiPut("/api/techregs", { items: DATA.technicalRegulations }));
}

function saveFiccNotes() {
  scheduleSave("ficc-notes", () => apiPut(`/api/ficc/notes${seasonQuery()}`, { notes: DATA.ficcBacklog.notes }));
}

function saveFiccProposal(driverId) {
  const p = DATA.ficcBacklog.proposals.find((p) => p.driverId === driverId);
  scheduleSave(`ficc-proposal:${driverId}`, () =>
    apiPut(`/api/ficc/proposals/${driverId}${seasonQuery()}`, {
      regulationName: p.regulationName,
      type: p.type,
      explanation: p.explanation,
      expiration: p.expiration,
    })
  );
}

function saveFiccFreeform() {
  const driverRowCount = DATA.drivers.length;
  const freeform = DATA.ficcBacklog.proposals.slice(driverRowCount);
  scheduleSave("ficc-freeform", () => apiPut(`/api/ficc/proposals/freeform${seasonQuery()}`, { items: freeform }));
}

function saveOffseasonRegs() {
  scheduleSave("offseason-regs", () => apiPut("/api/offseason/regulations", { items: DATA.offSeasonBudget.regulations }));
}

function saveOffseasonDriverTracker() {
  scheduleSave("offseason-dt", () => apiPut("/api/offseason/driver-tracker", { items: DATA.offSeasonBudget.driverTracker }));
}

function saveOffseasonMidSeason() {
  scheduleSave("offseason-msw", () => apiPut("/api/offseason/mid-season-window", { items: DATA.offSeasonBudget.midSeasonWindow }));
}

function saveHofSeasonLog() {
  scheduleSave("hof-seasonlog", () => apiPut("/api/halloffame/season-log", { items: DATA.hallOfFame.seasonLog }));
}

function saveHofMissedRaceLog() {
  scheduleSave("hof-missedrace", () => apiPut("/api/halloffame/missed-race-log", { items: DATA.hallOfFame.missedRaceLog }));
}

function saveUpgradePart(partNumber, fields) {
  scheduleSave(`upgrade-part:${partNumber}`, () => apiPut(`/api/admin/upgrade-parts/${partNumber}`, fields));
}

function saveSponsor(sponsorId, fields) {
  scheduleSave(`sponsor:${sponsorId}`, () => apiPut(`/api/admin/sponsors/${sponsorId}`, fields));
}

// ---------- generic add/delete tracker table ----------
// `allowed` gates editing/add/delete entirely (renders plain text instead);
// `onSave` is called after any in-place mutation to persist that section.
function genericTrackerPanel(title, arr, columns, makeEmptyRow, { allowed = true, onSave } = {}) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, title));
  if (arr.length === 0) {
    panel.appendChild(h("p", { class: "muted" }, allowed ? "No entries yet — add one below as it happens during the campaign." : "No entries yet."));
  }
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", {}, c.label)), h("th", {}))));
  const tbody = h("tbody");
  arr.forEach((row, i) => {
    const tr = h("tr");
    columns.forEach((c) => {
      const td = h("td");
      const val = row[c.key];
      if (!allowed) {
        td.appendChild(document.createTextNode(val ?? ""));
      } else if (c.type === "select" && c.key === "driver") {
        td.appendChild(driverSelectField(val, (v) => { row[c.key] = v || null; onSave(); }));
      } else if (c.type === "select") {
        td.appendChild(selectInput(val, ["", ...c.options()], (v) => { row[c.key] = v || null; onSave(); }));
      } else if (c.type === "number") {
        td.appendChild(numberInput(val, (v) => { row[c.key] = v; onSave(); }));
      } else {
        td.appendChild(textInput(val, (v) => { row[c.key] = v; onSave(); }));
      }
      tr.appendChild(td);
    });
    const tdDel = h("td");
    if (allowed) {
      const delBtn = h("button", { class: "btn small" }, "✕");
      delBtn.addEventListener("click", () => { arr.splice(i, 1); onSave(); renderActive(); });
      tdDel.appendChild(delBtn);
    }
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (allowed) {
    const addBtn = h("button", { class: "btn" }, "+ Add row");
    addBtn.addEventListener("click", () => { arr.push(makeEmptyRow()); onSave(); renderActive(); });
    panel.appendChild(addBtn);
  }
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
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Driver's Championship — " + (DATA.lore.driversTrophy.name || "")));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Race results are entered by the league admin."));
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
      if (allowed) {
        td.appendChild(numberInput(val, (v) => { d.races[i] = v; recomputeStandings(); renderActive(); saveStandingsRow(d.driverId); }));
      } else {
        td.appendChild(document.createTextNode(val ?? "—"));
      }
      tr.appendChild(td);
    });
    tr.appendChild(h("td", { class: "cell-computed" }, String(d.totalPoints)));
    tr.appendChild(h("td", { class: "cell-computed " + podiumClass("pos-", d.position) }, String(d.position)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  container.appendChild(panel);

  if (allowed) {
    const panel2 = h("div", { class: "panel" });
    const details = h("details");
    details.appendChild(h("summary", {}, "Points-per-position lookup table (edit to change scoring rules)"));
    const table2 = h("table");
    table2.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Position"), h("th", {}, "Points"))));
    const tbody2 = h("tbody");
    DATA.standings.pointsTable.forEach((row) => {
      const tr = h("tr", { class: podiumClass("pos-ref-", row.position) });
      const tdPos = h("td"); tdPos.appendChild(numberInput(row.position, (v) => { row.position = v; recomputeStandings(); renderActive(); savePointsTable(); }));
      const tdPts = h("td"); tdPts.appendChild(numberInput(row.points, (v) => { row.points = v; recomputeStandings(); renderActive(); savePointsTable(); }));
      tr.appendChild(tdPos); tr.appendChild(tdPts);
      tbody2.appendChild(tr);
    });
    table2.appendChild(tbody2);
    details.appendChild(table2);
    panel2.appendChild(details);
    container.appendChild(panel2);
  }
}

// ---------- credentials banner ----------
// Shown once after creating a driver or resetting a password — lives
// outside #tab-content so switching tabs / re-rendering doesn't wipe it
// before the admin has a chance to copy the temp password down.
function showBanner(contentEl, isError) {
  const banner = document.getElementById("credentials-banner");
  banner.innerHTML = "";
  banner.className = "credentials-banner" + (isError ? " error" : "");
  const closeBtn = h("button", { class: "btn small" }, "Dismiss");
  closeBtn.addEventListener("click", () => { banner.innerHTML = ""; banner.className = ""; });
  banner.appendChild(contentEl);
  banner.appendChild(closeBtn);
}

function showCredentialsBanner(heading, username, tempPassword) {
  showBanner(h("div", {},
    h("strong", {}, heading),
    h("div", { class: "muted", style: "margin-top:4px;" },
      "Username: ", h("code", {}, username), "   Temp password: ", h("code", {}, tempPassword),
      " — copy this down now, it won't be shown again."
    )
  ));
}

function showErrorBanner(heading, message) {
  showBanner(h("div", {}, h("strong", {}, heading), h("div", { class: "muted", style: "margin-top:4px;" }, message)), true);
}

// ---------- Drivers ----------
function renderDrivers(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "1961 Driver Lineup"));
  const grid = h("div", { class: "driver-grid" });
  DATA.drivers.forEach((d) => {
    const allowed = isSelfOrAdmin(d.driverId);
    const card = h("div", { class: "driver-card" });
    card.style.setProperty("--car-color", carColorMap()[d.carColor] || "#888");

    if (allowed) {
      const teamInput = textInput(d.teamName, (v) => { d.teamName = v; saveDriverFields(d.driverId, { teamName: v }); });
      teamInput.style.fontWeight = "700";
      teamInput.style.fontSize = "1.05rem";
      teamInput.style.marginBottom = "8px";
      card.appendChild(teamInput);
    } else {
      card.appendChild(h("div", { style: "font-weight:700; font-size:1.05rem; margin-bottom:8px;" }, d.teamName));
    }

    const row = h("div", { style: "display:flex; gap:8px; margin-bottom:8px;" });
    if (allowed) {
      row.appendChild(labeledField("Driver", textInput(d.driver, (v) => { d.driver = v; saveDriverFields(d.driverId, { driver: v }); })));
      row.appendChild(labeledField("Player", textInput(d.player, (v) => { d.player = v; saveDriverFields(d.driverId, { player: v }); })));
    } else {
      row.appendChild(labeledField("Driver", h("div", {}, d.driver)));
      row.appendChild(labeledField("Player", h("div", {}, d.player)));
    }
    card.appendChild(row);

    if (allowed) {
      const colorErrorEl = h("div", { class: "auth-error", style: "margin:4px 0 0; min-height:0;" });
      const colorSelect = selectInput(d.carColor, Object.keys(carColorMap()), async (v) => {
        const prevColor = d.carColor;
        colorErrorEl.textContent = "";
        try {
          await apiPut(`/api/drivers/${d.driverId}/car-color`, { carColor: v });
          d.carColor = v;
          card.style.setProperty("--car-color", carColorMap()[v] || "#888");
        } catch (err) {
          colorErrorEl.textContent = err.message;
          colorSelect.value = prevColor;
        }
      });
      card.appendChild(labeledField("Car Color", colorSelect));
      card.appendChild(colorErrorEl);
    } else {
      card.appendChild(labeledField("Car Color", h("div", {}, d.carColor)));
    }

    const details = h("details");
    details.appendChild(h("summary", {}, "Backstory"));
    if (allowed) {
      details.appendChild(textareaInput(d.backstory, (v) => { d.backstory = v; saveDriverFields(d.driverId, { backstory: v }); }, 6));
    } else {
      details.appendChild(h("p", { class: "muted" }, d.backstory || ""));
    }
    card.appendChild(details);

    if (isAdmin()) {
      const usernameRow = h("div", { style: "display:flex; gap:6px; align-items:flex-end; margin-top:10px;" });
      const usernameInput = h("input", { type: "text" });
      usernameInput.value = d.username || "";
      const usernameSaveBtn = h("button", { class: "btn small" }, "Save");
      usernameRow.appendChild(labeledField("Username (login)", usernameInput));
      usernameRow.appendChild(usernameSaveBtn);
      const usernameMsgEl = h("div", { class: "auth-error", style: "margin:4px 0 0; min-height:0;" });
      usernameSaveBtn.addEventListener("click", async () => {
        usernameMsgEl.textContent = "";
        const next = usernameInput.value.trim();
        if (!next || !d.username) return;
        usernameSaveBtn.disabled = true;
        try {
          const body = await apiPut(`/api/admin/users/${d.username}/username`, { newUsername: next });
          d.username = body.username;
        } catch (err) {
          usernameMsgEl.textContent = err.message;
          usernameInput.value = d.username || "";
        }
        usernameSaveBtn.disabled = false;
      });
      card.appendChild(usernameRow);
      card.appendChild(usernameMsgEl);

      const resetBtn = h("button", { class: "btn small", style: "margin-top:6px;" }, "Reset password");
      resetBtn.addEventListener("click", async () => {
        if (!d.username) return;
        resetBtn.disabled = true;
        try {
          const body = await apiPost(`/api/admin/users/${d.username}/reset-password`);
          showCredentialsBanner(`Password reset for ${d.driver}`, body.username, body.tempPassword);
        } catch (err) {
          showErrorBanner(`Could not reset password for ${d.driver}`, err.message);
        }
        resetBtn.disabled = false;
      });
      card.appendChild(resetBtn);

      const removeBtn = h("button", { class: "btn small danger", style: "margin-top:6px; margin-left:6px;" }, "Remove driver");
      removeBtn.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${d.driver} (${d.player})? This deletes their login and roster entry. Their past standings/upgrade tracker history stays but won't be shown anywhere.`)) return;
        removeBtn.disabled = true;
        try {
          await apiRequest("DELETE", `/api/admin/drivers/${d.driverId}`);
          await refreshData();
        } catch (err) {
          showErrorBanner(`Could not remove ${d.driver}`, err.message);
          removeBtn.disabled = false;
        }
      });
      card.appendChild(removeBtn);
    }

    grid.appendChild(card);
  });
  panel.appendChild(grid);
  container.appendChild(panel);

  if (isAdmin()) {
    container.appendChild(renderAddDriverForm());
    container.appendChild(renderAllUsersPanel());
  }
}

function renderAllUsersPanel() {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "All User Accounts"));
  const table = h("table");
  table.appendChild(
    h("thead", {}, h("tr", {}, h("th", {}, "Username"), h("th", {}, "Role"), h("th", {}, "Linked Driver"), h("th", {}, "Must Change Password"), h("th", {}, "")))
  );
  const tbody = h("tbody");
  table.appendChild(tbody);
  panel.appendChild(table);

  const errorEl = h("div", { class: "auth-error" });
  panel.appendChild(errorEl);

  apiGet("/api/admin/users")
    .then((users) => {
      // DATA.drivers doesn't carry driverId (see assembleData) — match by
      // username against the driver-tab rows instead, falling back to the
      // raw driverId if a driver's username was somehow never assigned.
      const driverNameByUsername = Object.fromEntries(DATA.drivers.filter((d) => d.username).map((d) => [d.username, d.driver]));
      users.forEach((u) => {
        const tr = h("tr");
        tr.appendChild(h("td", {}, u.username));
        tr.appendChild(h("td", {}, u.role));
        tr.appendChild(h("td", {}, u.driverId ? driverNameByUsername[u.username] || u.driverId : "—"));
        tr.appendChild(h("td", {}, u.mustChangePassword ? "Yes" : "No"));
        const tdReset = h("td");
        const resetBtn = h("button", { class: "btn small" }, "Reset password");
        resetBtn.addEventListener("click", async () => {
          resetBtn.disabled = true;
          try {
            const body = await apiPost(`/api/admin/users/${u.username}/reset-password`);
            showCredentialsBanner(`Password reset for ${u.username}`, body.username, body.tempPassword);
          } catch (err) {
            showErrorBanner(`Could not reset password for ${u.username}`, err.message);
          }
          resetBtn.disabled = false;
        });
        tdReset.appendChild(resetBtn);
        tr.appendChild(tdReset);
        tbody.appendChild(tr);
      });
    })
    .catch((err) => {
      errorEl.textContent = err.message;
    });

  return panel;
}

function renderAddDriverForm() {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Add Driver"));
  panel.appendChild(h("p", { class: "muted panel-note" }, "Creates both the driver record and their login. A temporary password is shown once — the driver sets their own on first login."));
  const errorEl = h("div", { class: "auth-error" });

  const driverInput = h("input", { type: "text", placeholder: "Driver name (required)" });
  const playerInput = h("input", { type: "text", placeholder: "Player name" });
  const teamInput = h("input", { type: "text", placeholder: "Team name" });
  const backstoryInput = h("textarea", { rows: "2", placeholder: "Backstory (optional)" });

  const row = h("div", { style: "display:flex; gap:10px; margin-bottom:10px;" });
  row.appendChild(labeledField("Driver name", driverInput));
  row.appendChild(labeledField("Player name", playerInput));
  row.appendChild(labeledField("Team name", teamInput));
  panel.appendChild(row);
  panel.appendChild(labeledField("Backstory", backstoryInput));
  panel.appendChild(errorEl);

  const addBtn = h("button", { class: "btn primary", style: "margin-top:10px;" }, "+ Add driver");
  addBtn.addEventListener("click", async () => {
    errorEl.textContent = "";
    if (!driverInput.value.trim()) {
      errorEl.textContent = "Driver name is required.";
      return;
    }
    addBtn.disabled = true;
    try {
      const body = await apiPost("/api/admin/drivers", {
        driver: driverInput.value.trim(),
        player: playerInput.value.trim(),
        teamName: teamInput.value.trim(),
        backstory: backstoryInput.value.trim(),
      });
      showCredentialsBanner(`Driver "${body.driver.driver}" created`, body.username, body.tempPassword);
      driverInput.value = ""; playerInput.value = ""; teamInput.value = ""; backstoryInput.value = "";
      await refreshData();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    addBtn.disabled = false;
  });
  panel.appendChild(addBtn);
  return panel;
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
// (The server recomputes these independently in assemble.js — this local
// copy is just so the UI updates instantly on edit, before the save
// round-trip returns.)
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
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Upgrade Tracker — Current Season"));
  if (DATA.upgradeTracker.rule) panel.appendChild(h("p", { class: "muted panel-note" }, DATA.upgradeTracker.rule));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Sponsor and upgrade-card assignment is managed by the league admin."));
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
    if (allowed) {
      sponsorTd.appendChild(selectInput(e.sponsor, ["", ...sponsorNames], (v) => { e.sponsor = v || null; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
    } else {
      sponsorTd.appendChild(document.createTextNode(e.sponsor || "—"));
    }
    tr.appendChild(sponsorTd);
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.budget)));
    e.upgrades.forEach((val, i) => {
      const td = h("td");
      if (allowed) {
        td.appendChild(upgradeSelect(val, (v) => { e.upgrades[i] = v; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
      } else {
        const u = DATA.inventory.upgrades.find((u) => u.partNumber === Number(val));
        td.appendChild(document.createTextNode(val != null ? `#${val}${u ? " · " + u.type : ""}` : "—"));
      }
      tr.appendChild(td);
    });
    const modTd = h("td");
    if (allowed) {
      modTd.appendChild(numberInput(e.modification, (v) => { e.modification = v; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
    } else {
      modTd.appendChild(document.createTextNode(String(e.modification ?? 0)));
    }
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
// Admin can edit existing rows (adding/removing parts or sponsors isn't
// wired up yet); drivers see the same table read-only.
const invFilter = { search: "", type: "", tier: "" };

function renderInventoryTableInto(holder) {
  holder.innerHTML = "";
  const allowed = isAdmin();
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
    if (allowed) {
      const tdType = h("td"); tdType.appendChild(textInput(u.type, (v) => { u.type = v; saveUpgradePart(u.partNumber, { type: v }); }));
      tr.appendChild(tdType);
      tr.appendChild(h("td", { class: "cell-computed" }, String(u.partNumber)));
      const tdEffect = h("td"); tdEffect.appendChild(textInput(u.effect, (v) => { u.effect = v; saveUpgradePart(u.partNumber, { effect: v }); }));
      tr.appendChild(tdEffect);
      const tdCount = h("td"); tdCount.appendChild(numberInput(u.countAvailable, (v) => { u.countAvailable = v; saveUpgradePart(u.partNumber, { countAvailable: v }); }));
      tr.appendChild(tdCount);
      const tdTier = h("td");
      const tierInput = textInput(u.tier, (v) => { u.tier = v; saveUpgradePart(u.partNumber, { tier: v }); renderInventoryTableInto(holder); });
      tierInput.classList.add("tier-" + u.tier);
      tdTier.appendChild(tierInput);
      tr.appendChild(tdTier);
      const tdCost = h("td"); tdCost.appendChild(numberInput(typeof u.cost === "number" ? u.cost : null, (v) => { u.cost = v; saveUpgradePart(u.partNumber, { cost: v }); }));
      tr.appendChild(tdCost);
    } else {
      tr.appendChild(h("td", {}, u.type));
      tr.appendChild(h("td", { class: "cell-computed" }, String(u.partNumber)));
      tr.appendChild(h("td", {}, u.effect || ""));
      tr.appendChild(h("td", {}, String(u.countAvailable ?? "")));
      tr.appendChild(h("td", {}, h("span", { class: "badge tier-" + u.tier }, String(u.tier))));
      tr.appendChild(h("td", {}, typeof u.cost === "number" ? fmtMoney(u.cost) : String(u.cost)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  holder.appendChild(table);
}

function renderInventory(container) {
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Upgrade Parts Inventory"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Read-only — managed by the league admin."));
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
    if (allowed) {
      const tdName = h("td"); tdName.appendChild(textInput(s.name, (v) => { s.name = v; saveSponsor(s.sponsorId, { name: v }); }));
      const tdType = h("td"); tdType.appendChild(textInput(s.type, (v) => { s.type = v; saveSponsor(s.sponsorId, { type: v }); }));
      const tdCount = h("td"); tdCount.appendChild(numberInput(s.countAvailable, (v) => { s.countAvailable = v; saveSponsor(s.sponsorId, { countAvailable: v }); }));
      const tdFund = h("td"); tdFund.appendChild(numberInput(s.funding, (v) => { s.funding = v; saveSponsor(s.sponsorId, { funding: v }); }));
      tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdCount); tr.appendChild(tdFund);
    } else {
      tr.appendChild(h("td", {}, s.name));
      tr.appendChild(h("td", {}, s.type || ""));
      tr.appendChild(h("td", {}, String(s.countAvailable ?? "")));
      tr.appendChild(h("td", {}, fmtMoney(s.funding)));
    }
    tbody2.appendChild(tr);
  });
  table2.appendChild(tbody2);
  panel2.appendChild(table2);
  container.appendChild(panel2);

  if (allowed) {
    container.appendChild(renderCarColorsPanel());
  }
}

function renderCarColorsPanel() {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Allowed Car Colors"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Color"), h("th", {}, "Swatch"), h("th", {}, ""))));
  const tbody = h("tbody");
  (DATA.carColors || []).forEach((c) => {
    const tr = h("tr");
    tr.appendChild(h("td", {}, c.name));
    const swatchTd = h("td");
    swatchTd.appendChild(colorSwatch(c.hex));
    tr.appendChild(swatchTd);
    const delTd = h("td");
    const delBtn = h("button", { class: "btn small" }, "Retire");
    delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      try {
        await apiRequest("DELETE", `/api/admin/car-colors/${encodeURIComponent(c.name)}`);
        await refreshData();
      } catch (err) {
        showErrorBanner(`Could not retire "${c.name}"`, err.message);
        delBtn.disabled = false;
      }
    });
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);

  const nameInput = h("input", { type: "text", placeholder: "Color name (e.g. Teal)" });
  const hexInput = h("input", { type: "text", placeholder: "#rrggbb" });
  const errorEl = h("div", { class: "auth-error" });
  const row = h("div", { style: "display:flex; gap:10px; margin-top:10px;" });
  row.appendChild(labeledField("Name", nameInput));
  row.appendChild(labeledField("Hex", hexInput));
  panel.appendChild(row);
  panel.appendChild(errorEl);
  const addBtn = h("button", { class: "btn primary", style: "margin-top:6px;" }, "+ Add color");
  addBtn.addEventListener("click", async () => {
    errorEl.textContent = "";
    addBtn.disabled = true;
    try {
      await apiPost("/api/admin/car-colors", { name: nameInput.value.trim(), hex: hexInput.value.trim() });
      nameInput.value = ""; hexInput.value = "";
      await refreshData();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    addBtn.disabled = false;
  });
  panel.appendChild(addBtn);
  return panel;
}

// ---------- Season & Schedule ----------
function renderSeason(container) {
  const s = DATA.season;
  const allowed = isAdmin();
  const isCurrent = DATA.viewedSeasonNumber === DATA.currentSeasonNumber;

  const bannerPanel = h("div", { class: "panel" });
  const statusLine = h("div", { style: "display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;" });
  statusLine.appendChild(
    h("div", {}, `Viewing season #${DATA.viewedSeasonNumber} (${s.label}) — `,
      isCurrent ? h("strong", { style: "color:var(--good);" }, "this is the current season") : h("span", { class: "muted" }, `current season is #${DATA.currentSeasonNumber}`)
    )
  );
  if (allowed && !isCurrent) {
    const setCurrentBtn = h("button", { class: "btn small" }, "Set as current season");
    setCurrentBtn.addEventListener("click", async () => {
      setCurrentBtn.disabled = true;
      try {
        await setCurrentSeason(DATA.viewedSeasonNumber);
        await refreshData();
      } catch (err) {
        showErrorBanner("Could not set current season", err.message);
        setCurrentBtn.disabled = false;
      }
    });
    statusLine.appendChild(setCurrentBtn);
  }
  bannerPanel.appendChild(statusLine);
  container.appendChild(bannerPanel);

  if (allowed) {
    const addSeasonPanel = h("div", { class: "panel" });
    addSeasonPanel.appendChild(h("h2", {}, "Add Season"));
    addSeasonPanel.appendChild(h("p", { class: "muted panel-note" }, "Starts empty — its own standings, upgrade tracker, and FICC backlog, separate from every other season."));
    const labelInput = h("input", { type: "text", placeholder: "Label (e.g. 1962)" });
    const errorEl = h("div", { class: "auth-error" });
    const row = h("div", { style: "display:flex; gap:10px; align-items:flex-end;" });
    row.appendChild(labeledField("Label", labelInput));
    const addBtn = h("button", { class: "btn primary" }, "+ Add season");
    addBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      addBtn.disabled = true;
      try {
        const created = await createSeason(labelInput.value.trim());
        VIEWED_SEASON = created.seasonNumber;
        await refreshData();
      } catch (err) {
        errorEl.textContent = err.message;
      }
      addBtn.disabled = false;
    });
    row.appendChild(addBtn);
    addSeasonPanel.appendChild(row);
    addSeasonPanel.appendChild(errorEl);
    container.appendChild(addSeasonPanel);
  }

  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Season Information"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Managed by the league admin."));
  const kv = h("div", { class: "kv-grid" });
  const addKV = (label, inputEl) => { kv.appendChild(h("label", {}, label)); kv.appendChild(inputEl); };
  addKV("Season number", h("div", { class: "cell-computed" }, String(s.seasonNumber ?? "")));
  if (allowed) {
    addKV("Label", textInput(s.label, (v) => { s.label = v; saveSeasonField({ label: v }); }));
    addKV("Races this season", numberInput(s.racesThisSeason, (v) => { s.racesThisSeason = v; saveSeasonField({ racesThisSeason: v }); }));
    addKV("Upgrade slots this season", numberInput(s.upgradeSlots, (v) => { s.upgradeSlots = v; saveSeasonField({ upgradeSlots: v }); }));
    addKV("Track selection method", textInput(s.trackSelectionMethod, (v) => { s.trackSelectionMethod = v; saveSeasonField({ trackSelectionMethod: v }); }));
    addKV("Mid-season break after race #", numberInput(s.midSeasonBreakAfterRace, (v) => { s.midSeasonBreakAfterRace = v; saveSeasonField({ midSeasonBreakAfterRace: v }); }));
    addKV("Legends enabled", selectInput(s.legends, ["Yes", "No"], (v) => { s.legends = v; saveSeasonField({ legends: v }); }));
    addKV("Base team budget", numberInput(s.baseTeamBudget, (v) => { s.baseTeamBudget = v; saveSeasonField({ baseTeamBudget: v }); }));
  } else {
    addKV("Label", h("div", {}, s.label || ""));
    addKV("Races this season", h("div", {}, String(s.racesThisSeason ?? "")));
    addKV("Upgrade slots this season", h("div", {}, String(s.upgradeSlots ?? "")));
    addKV("Track selection method", h("div", {}, s.trackSelectionMethod || ""));
    addKV("Mid-season break after race #", h("div", {}, String(s.midSeasonBreakAfterRace ?? "")));
    addKV("Legends enabled", h("div", {}, s.legends || ""));
    addKV("Base team budget", h("div", {}, fmtMoney(s.baseTeamBudget)));
  }
  panel.appendChild(kv);
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Race Schedule"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Race #"), h("th", {}, "Track"), h("th", {}, ""))));
  const tbody = h("tbody");
  s.schedule.forEach((r, i) => {
    const tr = h("tr");
    if (allowed) {
      const tdNum = h("td"); tdNum.appendChild(numberInput(r.race, (v) => { r.race = v; saveSeasonField({ schedule: s.schedule }); }));
      const tdTrack = h("td"); tdTrack.appendChild(textInput(r.track, (v) => { r.track = v; saveSeasonField({ schedule: s.schedule }); }));
      const tdDel = h("td");
      const delBtn = h("button", { class: "btn small" }, "✕");
      delBtn.addEventListener("click", () => { s.schedule.splice(i, 1); saveSeasonField({ schedule: s.schedule }); renderActive(); });
      tdDel.appendChild(delBtn);
      tr.appendChild(tdNum); tr.appendChild(tdTrack); tr.appendChild(tdDel);
    } else {
      tr.appendChild(h("td", {}, String(r.race)));
      tr.appendChild(h("td", {}, r.track));
      tr.appendChild(h("td", {}));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel2.appendChild(table);
  if (allowed) {
    const addBtn = h("button", { class: "btn" }, "+ Add race");
    addBtn.addEventListener("click", () => {
      const nextNum = (s.schedule.at(-1)?.race || 0) + 1;
      s.schedule.push({ race: nextNum, track: "" });
      saveSeasonField({ schedule: s.schedule });
      renderActive();
    });
    panel2.appendChild(addBtn);
  }
  container.appendChild(panel2);
}

// ---------- Technical Regulations ----------
function renderTechRegs(container) {
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "1961 Technical Regulations"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Managed by the league admin."));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Regulation"), h("th", {}, "Type"), h("th", {}, "Explanation"), h("th", {}, "Expiration"), h("th", {}, ""))));
  const tbody = h("tbody");
  DATA.technicalRegulations.forEach((r, i) => {
    const tr = h("tr");
    if (allowed) {
      const tdName = h("td"); tdName.appendChild(textInput(r.name, (v) => { r.name = v; saveTechRegs(); }));
      const tdType = h("td"); tdType.appendChild(textInput(r.type, (v) => { r.type = v; saveTechRegs(); }));
      const tdExp = h("td"); tdExp.appendChild(textareaInput(r.explanation, (v) => { r.explanation = v; saveTechRegs(); }, 2));
      const tdExpr = h("td"); tdExpr.appendChild(textInput(r.expiration, (v) => { r.expiration = v; saveTechRegs(); }));
      const tdDel = h("td");
      const b = h("button", { class: "btn small" }, "✕");
      b.addEventListener("click", () => { DATA.technicalRegulations.splice(i, 1); saveTechRegs(); renderActive(); });
      tdDel.appendChild(b);
      tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdExp); tr.appendChild(tdExpr); tr.appendChild(tdDel);
    } else {
      tr.appendChild(h("td", {}, r.name));
      tr.appendChild(h("td", {}, r.type));
      tr.appendChild(h("td", {}, r.explanation));
      tr.appendChild(h("td", {}, r.expiration));
      tr.appendChild(h("td", {}));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (allowed) {
    const addBtn = h("button", { class: "btn" }, "+ Add regulation");
    addBtn.addEventListener("click", () => { DATA.technicalRegulations.push({ name: "", type: "", explanation: "", expiration: "" }); saveTechRegs(); renderActive(); });
    panel.appendChild(addBtn);
  }
  container.appendChild(panel);
}

// ---------- FICC Backlog ----------
function renderFiccBacklog(container) {
  const notesAllowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "FICC Rules Backlog"));
  DATA.ficcBacklog.notes.forEach((note, i) => {
    if (notesAllowed) {
      panel.appendChild(textareaInput(note, (v) => { DATA.ficcBacklog.notes[i] = v; saveFiccNotes(); }, 2));
    } else {
      panel.appendChild(h("p", { class: "muted" }, note));
    }
  });
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Proposed Regulations"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Proposed Regulation"), h("th", {}, "Type"), h("th", {}, "Explanation"), h("th", {}, "Expiration"), h("th", {}, ""))));
  const tbody = h("tbody");
  // The first N proposal rows are INDEX'd from the driver lineup in the sheet
  // (one proposal slot per driver) — driver-owned-editable, like the Drivers
  // tab. The remaining freeform rows are admin-only.
  const driverRowCount = DATA.drivers.length;
  DATA.ficcBacklog.proposals.forEach((p, i) => {
    const isDriverRow = i < driverRowCount;
    if (isDriverRow) p.driverName = DATA.drivers[i]?.driver ?? p.driverName;
    const rowAllowed = isDriverRow ? isSelfOrAdmin(p.driverId) : isAdmin();
    const tr = h("tr");
    const tdDriver = h("td");
    if (isDriverRow) {
      tdDriver.appendChild(driverBadge(p.driverName));
    } else if (isAdmin()) {
      tdDriver.appendChild(driverSelectField(p.driverName, (v) => { p.driverName = v || null; saveFiccFreeform(); }));
    } else {
      tdDriver.appendChild(document.createTextNode(p.driverName || ""));
    }
    const onProposalChange = isDriverRow ? () => saveFiccProposal(p.driverId) : () => saveFiccFreeform();
    if (rowAllowed) {
      const tdReg = h("td"); tdReg.appendChild(textInput(p.regulationName, (v) => { p.regulationName = v; onProposalChange(); }));
      const tdType = h("td"); tdType.appendChild(textInput(p.type, (v) => { p.type = v; onProposalChange(); }));
      const tdExp = h("td"); tdExp.appendChild(textareaInput(p.explanation, (v) => { p.explanation = v; onProposalChange(); }, 2));
      const tdExpr = h("td"); tdExpr.appendChild(textInput(p.expiration, (v) => { p.expiration = v; onProposalChange(); }));
      tr.appendChild(tdDriver); tr.appendChild(tdReg); tr.appendChild(tdType); tr.appendChild(tdExp); tr.appendChild(tdExpr);
    } else {
      tr.appendChild(tdDriver);
      tr.appendChild(h("td", {}, p.regulationName || ""));
      tr.appendChild(h("td", {}, p.type || ""));
      tr.appendChild(h("td", {}, p.explanation || ""));
      tr.appendChild(h("td", {}, p.expiration || ""));
    }
    const tdDel = h("td");
    if (!isDriverRow && isAdmin()) {
      const b = h("button", { class: "btn small" }, "✕");
      b.addEventListener("click", () => { DATA.ficcBacklog.proposals.splice(i, 1); saveFiccFreeform(); renderActive(); });
      tdDel.appendChild(b);
    }
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel2.appendChild(table);
  if (isAdmin()) {
    const addBtn = h("button", { class: "btn" }, "+ Add proposal");
    addBtn.addEventListener("click", () => { DATA.ficcBacklog.proposals.push({ driverName: null, regulationName: "", type: "", explanation: "", expiration: "" }); saveFiccFreeform(); renderActive(); });
    panel2.appendChild(addBtn);
  }
  container.appendChild(panel2);
}

// ---------- Off-Season Budget ----------
function renderOffSeason(container) {
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Off-Season Upgrade Budget — Catch-up System"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Managed by the league admin."));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Tier"), h("th", {}, "Upgrade Exchange"), h("th", {}, "Heat Cards"), h("th", {}, "Winnings"))));
  const tbody = h("tbody");
  DATA.offSeasonBudget.regulations.forEach((r) => {
    const tr = h("tr");
    if (allowed) {
      const tdTier = h("td"); tdTier.appendChild(textInput(r.tier, (v) => { r.tier = v; saveOffseasonRegs(); }));
      const tdEx = h("td"); tdEx.appendChild(textInput(r.upgradeExchange, (v) => { r.upgradeExchange = v; saveOffseasonRegs(); }));
      const tdHeat = h("td"); tdHeat.appendChild(textInput(r.heatCards, (v) => { r.heatCards = v; saveOffseasonRegs(); }));
      const tdWin = h("td"); tdWin.appendChild(textareaInput(String(r.winnings ?? ""), (v) => { r.winnings = v; saveOffseasonRegs(); }, 2));
      tr.appendChild(tdTier); tr.appendChild(tdEx); tr.appendChild(tdHeat); tr.appendChild(tdWin);
    } else {
      tr.appendChild(h("td", {}, r.tier));
      tr.appendChild(h("td", {}, r.upgradeExchange));
      tr.appendChild(h("td", {}, r.heatCards));
      tr.appendChild(h("td", {}, String(r.winnings ?? "")));
    }
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
    () => ({ driver: null, upgradeOut: "", upgradeIn: "", heatCardsReceived: "", winningsReceived: null, note: "" }),
    { allowed, onSave: saveOffseasonDriverTracker }
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
    () => ({ driver: null, upgradeOut: "", upgradeIn: "", note: "" }),
    { allowed, onSave: saveOffseasonMidSeason }
  ));
}

// ---------- Hall of Fame ----------
function renderHallOfFame(container) {
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Season-by-Season Champion Log"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Managed by the league admin."));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Season"), h("th", {}, "Driver's Champion"), h("th", {}, "Constructor's Champion"))));
  const tbody = h("tbody");
  DATA.hallOfFame.seasonLog.forEach((row) => {
    const tr = h("tr");
    tr.appendChild(h("td", { class: "cell-computed" }, String(row.season)));
    if (allowed) {
      const tdChamp = h("td"); tdChamp.appendChild(textInput(row.champion, (v) => { row.champion = v; saveHofSeasonLog(); }));
      const tdCons = h("td"); tdCons.appendChild(textInput(row.constructorChampion, (v) => { row.constructorChampion = v; saveHofSeasonLog(); }));
      tr.appendChild(tdChamp); tr.appendChild(tdCons);
    } else {
      tr.appendChild(h("td", {}, row.champion || ""));
      tr.appendChild(h("td", {}, row.constructorChampion || ""));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (allowed) {
    const addBtn = h("button", { class: "btn" }, "+ Add season");
    addBtn.addEventListener("click", () => {
      const next = (DATA.hallOfFame.seasonLog.at(-1)?.season || 0) + 1;
      DATA.hallOfFame.seasonLog.push({ season: next, champion: null, constructorChampion: null });
      saveHofSeasonLog(); renderActive();
    });
    panel.appendChild(addBtn);
  }
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
    () => ({ season: DATA.season.seasonNumber, race: "", driver: null, legendSub: "", pointsEarned: null, note: "" }),
    { allowed, onSave: saveHofMissedRaceLog }
  ));
}

// ---------- Lore ----------
// Admin-only, full stop — everyone else gets a read-only view.
function renderLore(container) {
  const l = DATA.lore;
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "League"));
  if (!allowed) panel.appendChild(h("p", { class: "muted panel-note" }, "Lore & Trophies is managed by the league admin."));
  const kv = h("div", { class: "kv-grid" });
  const addKV = (label, inputEl) => { kv.appendChild(h("label", {}, label)); kv.appendChild(inputEl); };
  if (allowed) {
    addKV("League name", textInput(l.leagueName, (v) => { l.leagueName = v; saveLoreField({ leagueName: v }); document.getElementById("league-name").textContent = v; }));
    addKV("Governing body", textInput(l.governingBody, (v) => { l.governingBody = v; saveLoreField({ governingBody: v }); }));
    addKV("Founded", textareaInput(l.founded, (v) => { l.founded = v; saveLoreField({ founded: v }); }, 2));
    addKV("Motto", textInput(l.motto, (v) => { l.motto = v; saveLoreField({ motto: v }); }));
  } else {
    addKV("League name", h("div", {}, l.leagueName || ""));
    addKV("Governing body", h("div", {}, l.governingBody || ""));
    addKV("Founded", h("p", { class: "muted" }, l.founded || ""));
    addKV("Motto", h("div", {}, l.motto || ""));
  }
  panel.appendChild(kv);
  container.appendChild(panel);

  const mkTrophyBlock = (title, trophy, key) => {
    const block = h("div", { class: "panel lore-block" });
    block.appendChild(h("h2", {}, title));
    if (allowed) {
      block.appendChild(labeledField("Trophy name", textInput(trophy.name, (v) => { trophy.name = v; saveLoreField({ [key]: trophy }); })));
      block.appendChild(labeledField("Awarded to", textInput(trophy.awardedTo, (v) => { trophy.awardedTo = v; saveLoreField({ [key]: trophy }); })));
      block.appendChild(labeledField(`About ${trophy.aboutPerson || ""}`, textareaInput(trophy.about, (v) => { trophy.about = v; saveLoreField({ [key]: trophy }); }, 10)));
    } else {
      block.appendChild(labeledField("Trophy name", h("div", {}, trophy.name || "")));
      block.appendChild(labeledField("Awarded to", h("div", {}, trophy.awardedTo || "")));
      block.appendChild(labeledField(`About ${trophy.aboutPerson || ""}`, h("p", { class: "muted" }, trophy.about || "")));
    }
    return block;
  };
  container.appendChild(mkTrophyBlock("Driver's Trophy", l.driversTrophy, "driversTrophy"));
  container.appendChild(mkTrophyBlock("Constructor's Trophy", l.constructorsTrophy, "constructorsTrophy"));

  const panel3 = h("div", { class: "panel" });
  panel3.appendChild(h("h2", {}, "Backstory Note"));
  if (allowed) {
    panel3.appendChild(textareaInput(l.backstoryNote, (v) => { l.backstoryNote = v; saveLoreField({ backstoryNote: v }); }, 4));
  } else {
    panel3.appendChild(h("p", { class: "muted" }, l.backstoryNote || ""));
  }
  container.appendChild(panel3);
}

// ---------- My Account (profile) ----------
// Every logged-in user gets this tab — no permission gate beyond being
// authenticated, since it only ever acts on the caller's own account.
function renderProfile(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Account"));
  const kv = h("div", { class: "kv-grid" });
  kv.appendChild(h("label", {}, "Role"));
  kv.appendChild(h("div", {}, CURRENT_USER.role));
  if (CURRENT_USER.driverId) {
    const myDriver = DATA.drivers.find((d) => d.driverId === CURRENT_USER.driverId);
    kv.appendChild(h("label", {}, "Driver"));
    kv.appendChild(h("div", {}, myDriver ? myDriver.driver : CURRENT_USER.driverId));
  }
  panel.appendChild(kv);
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Username"));
  const usernameInput = h("input", { type: "text" });
  usernameInput.value = CURRENT_USER.username;
  const usernameMsgEl = h("div", { class: "auth-error" });
  const usernameBtn = h("button", { class: "btn primary" }, "Save username");
  usernameBtn.addEventListener("click", async () => {
    usernameMsgEl.style.color = "";
    usernameMsgEl.textContent = "";
    const next = usernameInput.value.trim();
    if (!next) { usernameMsgEl.textContent = "Username can't be blank."; return; }
    usernameBtn.disabled = true;
    try {
      const body = await apiPut("/api/auth/username", { newUsername: next });
      CURRENT_USER.username = body.username;
      document.getElementById("whoami").textContent = `${CURRENT_USER.username} (${CURRENT_USER.role})`;
      usernameMsgEl.style.color = "var(--good)";
      usernameMsgEl.textContent = "Username updated.";
    } catch (err) {
      usernameMsgEl.textContent = err.message;
      usernameInput.value = CURRENT_USER.username;
    }
    usernameBtn.disabled = false;
  });
  panel2.appendChild(labeledField("Username (used to log in)", usernameInput));
  panel2.appendChild(usernameMsgEl);
  panel2.appendChild(usernameBtn);
  container.appendChild(panel2);

  const panel3 = h("div", { class: "panel" });
  panel3.appendChild(h("h2", {}, "Change Password"));
  const currentPwInput = h("input", { type: "password", autocomplete: "current-password" });
  const newPwInput = h("input", { type: "password", autocomplete: "new-password" });
  const confirmPwInput = h("input", { type: "password", autocomplete: "new-password" });
  const pwMsgEl = h("div", { class: "auth-error" });
  panel3.appendChild(labeledField("Current password", currentPwInput));
  panel3.appendChild(labeledField("New password (8+ characters)", newPwInput));
  panel3.appendChild(labeledField("Confirm new password", confirmPwInput));
  panel3.appendChild(pwMsgEl);
  const pwBtn = h("button", { class: "btn primary" }, "Update password");
  pwBtn.addEventListener("click", async () => {
    pwMsgEl.style.color = "";
    pwMsgEl.textContent = "";
    if (newPwInput.value !== confirmPwInput.value) { pwMsgEl.textContent = "Passwords don't match."; return; }
    pwBtn.disabled = true;
    try {
      await apiPost("/api/auth/change-password", { currentPassword: currentPwInput.value, newPassword: newPwInput.value });
      currentPwInput.value = ""; newPwInput.value = ""; confirmPwInput.value = "";
      pwMsgEl.style.color = "var(--good)";
      pwMsgEl.textContent = "Password updated.";
    } catch (err) {
      pwMsgEl.textContent = err.message;
    }
    pwBtn.disabled = false;
  });
  panel3.appendChild(pwBtn);
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
  { id: "profile", label: "My Account", render: renderProfile },
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
  // Attach each row's owning driverId (from the server-assembled driverIds
  // list, same order as DATA.drivers) so save calls know which per-driver
  // endpoint to hit and requireSelfOrAdmin checks have something to compare.
  const ids = DATA.driverIds || [];
  DATA.drivers.forEach((d, i) => { d.driverId = ids[i]; });
  DATA.standings.drivers.forEach((d, i) => { d.driverId = ids[i]; });
  DATA.upgradeTracker.entries.forEach((e, i) => { e.driverId = ids[i]; });
  DATA.ficcBacklog.proposals.forEach((p, i) => { if (i < ids.length) p.driverId = ids[i]; });
}

// ---------- auth ----------
let CURRENT_USER = null;

function showAuthScreen(contentEl) {
  document.getElementById("app-shell").style.display = "none";
  const authEl = document.getElementById("auth-screen");
  authEl.innerHTML = "";
  authEl.className = "auth-screen";
  authEl.appendChild(contentEl);
}

function showApp() {
  document.getElementById("auth-screen").innerHTML = "";
  document.getElementById("auth-screen").className = "";
  document.getElementById("app-shell").style.display = "";
}

function renderLoginForm() {
  const card = h("div", { class: "auth-card" });
  card.appendChild(h("h1", {}, "🏁 Calore 1"));
  card.appendChild(h("p", { class: "muted" }, "Sign in to view or edit the campaign."));
  const errorEl = h("div", { class: "auth-error" });

  const usernameInput = h("input", { type: "text", autocomplete: "username" });
  const passwordInput = h("input", { type: "password", autocomplete: "current-password" });

  const form = h("form");
  const usernameField = h("div", { class: "auth-field" });
  usernameField.appendChild(h("label", {}, "Username"));
  usernameField.appendChild(usernameInput);
  const passwordField = h("div", { class: "auth-field" });
  passwordField.appendChild(h("label", {}, "Password"));
  passwordField.appendChild(passwordInput);
  form.appendChild(usernameField);
  form.appendChild(passwordField);
  form.appendChild(errorEl);
  const submitBtn = h("button", { class: "btn primary", type: "submit" }, "Log in");
  form.appendChild(submitBtn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value }),
      });
      const body = await res.json();
      if (!res.ok) {
        errorEl.textContent = body.error || "Login failed";
        submitBtn.disabled = false;
        return;
      }
      CURRENT_USER = body;
      if (body.mustChangePassword) {
        showAuthScreen(renderChangePasswordForm());
      } else {
        showApp();
        await loadAppData();
      }
    } catch (err) {
      errorEl.textContent = "Could not reach the server.";
      submitBtn.disabled = false;
    }
  });

  card.appendChild(form);
  return card;
}

function renderChangePasswordForm() {
  const card = h("div", { class: "auth-card" });
  card.appendChild(h("h1", {}, "Set a new password"));
  card.appendChild(h("p", { class: "muted" }, "You're logging in with a temporary password — set your own before continuing."));
  const errorEl = h("div", { class: "auth-error" });

  const currentInput = h("input", { type: "password", autocomplete: "current-password" });
  const newInput = h("input", { type: "password", autocomplete: "new-password" });
  const confirmInput = h("input", { type: "password", autocomplete: "new-password" });

  const form = h("form");
  const f1 = h("div", { class: "auth-field" }); f1.appendChild(h("label", {}, "Temporary password")); f1.appendChild(currentInput);
  const f2 = h("div", { class: "auth-field" }); f2.appendChild(h("label", {}, "New password (8+ characters)")); f2.appendChild(newInput);
  const f3 = h("div", { class: "auth-field" }); f3.appendChild(h("label", {}, "Confirm new password")); f3.appendChild(confirmInput);
  form.appendChild(f1); form.appendChild(f2); form.appendChild(f3); form.appendChild(errorEl);
  const submitBtn = h("button", { class: "btn primary", type: "submit" }, "Set password & continue");
  form.appendChild(submitBtn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    if (newInput.value !== confirmInput.value) {
      errorEl.textContent = "Passwords don't match.";
      return;
    }
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentInput.value, newPassword: newInput.value }),
      });
      const body = await res.json();
      if (!res.ok) {
        errorEl.textContent = body.error || "Could not update password";
        submitBtn.disabled = false;
        return;
      }
      showApp();
      await loadAppData();
    } catch (err) {
      errorEl.textContent = "Could not reach the server.";
      submitBtn.disabled = false;
    }
  });

  card.appendChild(form);
  return card;
}

// Refetches the assembled data blob and re-renders the active tab — used
// both for the initial load and after an action (like creating a driver)
// that changes the shape of DATA in ways too fiddly to patch in place
// (a new driver needs matching standings/upgrade-tracker/FICC rows, which
// only the server's assemble.js knows how to default correctly).
async function refreshData() {
  const res = await fetch(`/api/data${seasonQuery()}`);
  DATA = await res.json();
  // Sync from the server's resolved value — on first load VIEWED_SEASON is
  // null (server picks the current season), and after that this just
  // confirms it matches what we asked for.
  VIEWED_SEASON = DATA.viewedSeasonNumber;
  normalizeData();
  renderSeasonSwitcher();
  renderActive();
}

function renderSeasonSwitcher() {
  const holder = document.getElementById("season-switcher");
  holder.innerHTML = "";
  const select = selectInput(
    String(VIEWED_SEASON),
    DATA.seasons.map((s) => ({ value: String(s.seasonNumber), label: s.label })),
    async (v) => {
      VIEWED_SEASON = Number(v);
      await refreshData();
    }
  );
  holder.appendChild(select);
}

async function loadAppData() {
  await refreshData();
  document.getElementById("league-name").textContent = DATA.lore.leagueName || "Calore 1";
  document.getElementById("league-sub").textContent = `${DATA.lore.governingBody || ""}`;
  document.getElementById("whoami").textContent = CURRENT_USER
    ? `${CURRENT_USER.username} (${CURRENT_USER.role})`
    : "";
  setSaveState("saved");
  document.getElementById("save-now-btn").addEventListener("click", () => flushAllSaves());
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  });
  renderTabs();
}

async function init() {
  const res = await fetch("/api/auth/me");
  if (!res.ok) {
    showAuthScreen(renderLoginForm());
    return;
  }
  CURRENT_USER = await res.json();
  if (CURRENT_USER.mustChangePassword) {
    showAuthScreen(renderChangePasswordForm());
    return;
  }
  showApp();
  await loadAppData();
}

init();
