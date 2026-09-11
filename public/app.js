// Calore 1 campaign tracker — vanilla JS, no build step.

let DATA = null;
let MAX_UPGRADE_SLOTS = 3;
let activeTab = "home";
let homeExpandedCard = "standings";
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

// Curated font list for the Driver Number Badge (My Account page) — bold
// block/display faces suited to racing numerals, not script/serif. Fixed
// list, no admin management (see the Google Fonts <link> in index.html).
// Each `family` embeds its own fallback stack so a slow/blocked font load
// never leaves the badge illegible.
const NUMBER_BADGE_FONTS = [
  { id: "orbitron", label: "Orbitron", family: '"Orbitron", "Courier New", monospace' },
  { id: "racing-sans-one", label: "Racing Sans One", family: '"Racing Sans One", "Arial Narrow", sans-serif' },
  { id: "bebas-neue", label: "Bebas Neue", family: '"Bebas Neue", "Arial Narrow", sans-serif' },
  { id: "anton", label: "Anton", family: '"Anton", "Arial Black", sans-serif' },
  { id: "titillium-web", label: "Titillium Web", family: '"Titillium Web", Arial, sans-serif' },
];

// Lightens (positive percent) or darkens (negative) a #rrggbb hex color —
// used only to brighten the car color for numberBadge()'s glow effect.
function shadeColor(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amt));
  const b = Math.min(255, Math.max(0, (n & 0xff) + amt));
  return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

// Deliberately just two simple, independent choices (an earlier round of
// this feature tried gradient/pattern fills plus a 6-way contrast picker —
// too many options, and busy patterns buried the car color instead of
// showing it plainly). The numeral itself is now always a flat, solid
// color — bold and unambiguous — never a gradient or texture. "Glow" is
// the old boxless default ("None" — no backdrop element, still supported
// via resolveBgShape below for anyone who already saved that value);
// "Outline" is a crisp solid stroke around the glyph, distinct from
// Glow's soft blur. All four apply NUMBER_BG_COLORS the same way (see
// numberBadge): whichever of white/team-color the background element
// itself is (glow color, outline color, or backdrop chip fill), the
// numeral is always the other one.
const NUMBER_BG_SHAPES = [
  { id: "glow", label: "Glow" },
  { id: "outline", label: "Outline" },
  { id: "circle", label: "Circle" },
  { id: "square", label: "Square" },
];
const NUMBER_BG_COLORS = [
  { id: "white", label: "White" },
  { id: "team", label: "Team color" },
];

// Maps a stored numberBgShape to a currently-valid NUMBER_BG_SHAPES id —
// "none" (or unset) becomes "glow", its closest equivalent (no backdrop
// element) from before "None" was removed as an option.
function resolveBgShape(id) {
  if (!id || id === "none") return "glow";
  return id;
}

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

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return n + "th";
  switch (n % 10) {
    case 1: return n + "st";
    case 2: return n + "nd";
    case 3: return n + "rd";
    default: return n + "th";
  }
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

function checkboxInput(checked, onChange) {
  const inp = h("input", { type: "checkbox" });
  inp.checked = !!checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return inp;
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

// Depleted parts are still selectable — availability alone doesn't decide
// who gets a part, priority does (see server/db/priority.js). A driver who
// outranks the part's current lowest-priority holder can still legitimately
// claim it, bumping that holder into "out of compliance" rather than being
// blocked here.
function upgradeSelect(value, onChange) {
  // Monospaced (see .upgrade-select in style.css) so the padded columns
  // below actually line up into a table instead of ragged inline text.
  const sel = h("select", { class: "upgrade-select" });
  sel.appendChild(h("option", { value: "" }, "— none —"));
  // Season rules (Card Restrictions, below the Upgrade Tracker) remove
  // banned tiers/types from the option list entirely — except the part
  // already sitting in this slot, which stays visible even if a rule
  // change makes it no longer pickable, so the select never shows a value
  // with no matching option.
  const allowedTiers = DATA.season.allowedTiers || [];
  const disallowedTypes = new Set(DATA.season.disallowedTypes || []);
  const groups = {};
  for (const u of DATA.inventory.upgrades) {
    const isCurrent = value != null && String(u.partNumber) === String(value);
    const tierBanned = allowedTiers.length > 0 && !allowedTiers.includes(String(u.tier));
    const typeBanned = disallowedTypes.has(u.type);
    if ((tierBanned || typeBanned) && !isCurrent) continue;
    (groups[u.type] ||= []).push(u);
  }

  // Column widths sized off the full part list (not just what's visible in
  // this particular select) so padding stays consistent across every
  // Upgrade Tracker dropdown regardless of season restrictions filtering
  // some of them out.
  const costText = (u) => (typeof u.cost === "number" ? fmtMoney(u.cost) : String(u.cost));
  const partWidth = Math.max(...DATA.inventory.upgrades.map((u) => String(u.partNumber).length + 1));
  const costWidth = Math.max(...DATA.inventory.upgrades.map((u) => costText(u).length));

  for (const [type, list] of Object.entries(groups)) {
    const og = h("optgroup", { label: type });
    // Best tier first (S, then A/B/C/D/F, unranked last).
    const sorted = [...list].sort((a, b) => (TIER_RANK[a.tier] ?? 6) - (TIER_RANK[b.tier] ?? 6) || a.partNumber - b.partNumber);
    for (const u of sorted) {
      const isCurrent = value != null && String(u.partNumber) === String(value);
      const partCol = `#${u.partNumber}`.padEnd(partWidth);
      const tierCol = String(u.tier).padEnd(2);
      const costCol = costText(u).padStart(costWidth);
      const label = `${partCol} ${tierCol} ${costCol}`;
      const o = h("option", { value: String(u.partNumber) }, label);
      if (isCurrent) o.selected = true;
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

// The "badge" half of driverIndicator below — only ever called once a
// driver has set a driverNumber. Falls back to the first curated font/
// style if the driver's saved id no longer matches one (e.g. a curated
// list entry got renamed/removed).
function numberBadge(driver) {
  const font = NUMBER_BADGE_FONTS.find((f) => f.id === driver.numberFont) || NUMBER_BADGE_FONTS[0];
  const shape = resolveBgShape(driver.numberBgShape);
  const bgColorChoice = driver.numberBgColor || NUMBER_BG_COLORS[0].id;
  const carColor = carColorMap()[driver.carColor] || "#888";

  // "White" background: the background element (glow/outline/backdrop
  // chip, whichever `shape` is) is white, and the numeral is the bold car
  // color — the plain default. "Team color" inverts it: the background
  // element becomes the car color, and the numeral becomes white instead,
  // so it always reads clearly against whichever color it's paired with.
  const inverted = bgColorChoice === "team";
  const numberColor = inverted ? "#fff" : carColor;
  const bgColor = inverted ? carColor : "#fff";

  const glyph = h("span", { class: "number-glyph" }, driver.driverNumber);
  glyph.style.margin = "0";
  glyph.style.flex = "none";
  glyph.style.fontFamily = font.family;
  glyph.style.color = numberColor;

  if (shape === "glow") {
    // No backdrop — a soft glow in bgColor both keeps a boxless numeral
    // legible against the app's dark theme (crucially, even when the
    // numeral itself is a very dark car color like "Black") and is what
    // actually makes the color pop, the same layering a neon-sign glow
    // uses. Brightened for the "team" case so a dark car color's glow
    // doesn't look muted either; "white" is already as bright as it gets.
    const glowCore = inverted ? shadeColor(bgColor, 30) : bgColor;
    glyph.style.filter = `drop-shadow(0 0 2px ${glowCore}) drop-shadow(0 0 6px ${bgColor})`;
    return glyph;
  }

  if (shape === "outline") {
    // A crisp solid stroke around the glyph — no blur, unlike Glow — so
    // even a numeral the same brightness as the app's background stays
    // clearly outlined. White (the non-inverted case) reads thicker than
    // a car-color stroke at the same width — white has no hue to "blend"
    // into the fill's edge the way a car color can — so it gets an even
    // thinner stroke than the team-color case.
    glyph.style.webkitTextStroke = `${inverted ? "2px" : "0.6px"} ${bgColor}`;
    return glyph;
  }

  // Circle/square — a solid backdrop chip behind the glyph, sized off
  // .number-glyph-wrap's own padding (see style.css) so it automatically
  // scales with 1 vs. 2 digits instead of a fixed pixel size.
  glyph.style.position = "relative";
  glyph.style.zIndex = "1";
  const backdrop = h("span", { class: `number-glyph-backdrop number-glyph-backdrop--${shape}` });
  backdrop.style.background = bgColor;
  const wrap = h("span", { class: "number-glyph-wrap" }, backdrop, glyph);
  wrap.style.margin = "0";
  wrap.style.flex = "none";
  return wrap;
}

// Single place the "dot vs. number badge" decision is made — driverBadge
// and driverSelectField both call this so they can never drift out of
// sync. Falls back to the plain color dot whenever driverNumber is unset,
// so nobody who hasn't opted into the badge feature sees any change.
function driverIndicator(driver) {
  if (driver && driver.driverNumber) return numberBadge(driver);
  return colorSwatch(driver ? carColorMap()[driver.carColor] || null : null);
}

// Plain-text driver name with an indicator (color dot, or a number badge
// if that driver has set one) — used wherever the name is derived/
// read-only (Standings, Upgrade Tracker, the fixed FICC proposal rows).
function driverBadge(name) {
  const span = h("span", { style: "display:inline-flex; align-items:center; gap:6px;" });
  const d = DATA.drivers.find((d) => d.driver === name);
  span.appendChild(driverIndicator(d));
  span.appendChild(document.createTextNode(name || ""));
  return span;
}

// Editable driver <select> with the same indicator, kept in sync as the
// selection changes — used in the freeform tracker tables. The indicator
// element itself is swapped (not just re-styled) since a color dot and a
// number badge are different shapes, not just different colors of the
// same element.
function driverSelectField(value, onChange) {
  const wrap = h("div", { style: "display:flex; align-items:center; gap:6px;" });
  let indicator = driverIndicator(DATA.drivers.find((d) => d.driver === value));
  wrap.appendChild(indicator);
  const sel = selectInput(value, ["", ...DATA.drivers.map((d) => d.driver)], (v) => {
    const next = driverIndicator(DATA.drivers.find((d) => d.driver === v));
    wrap.replaceChild(next, indicator);
    indicator = next;
    onChange(v);
  });
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

// driverId -> message, for an Upgrade Tracker save rejected outright (e.g.
// the one-type-per-driver rule in server/routes/upgrade-tracker.routes.js).
// Kept separate from DATA (which a rejected save never actually reaches)
// so renderUpgradeTracker can flag that driver's row the same way it
// already flags an oversubscribed pick — a highlighted row plus a "!"
// detail line — instead of the generic top-bar save error. Cleared on
// that driver's next successful save.
const upgradeTrackerRowErrors = new Map();

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
  if (!res.ok) {
    const err = new Error(responseBody.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
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
    pendingSaveCount = Math.max(0, pendingSaveCount - 1);
    // A 4xx means the request itself is invalid (e.g. a priority-aware
    // upgrade-pick rejection) — retrying it verbatim every 2s would just
    // fail forever. Give up, show why, and resync so the optimistic edit
    // that caused it reverts to what the server actually has stored.
    if (err.status >= 400 && err.status < 500) {
      setSaveState("error");
      const el = document.getElementById("save-state");
      if (el) { el.textContent = err.message; el.title = err.message; }
      refreshData();
      return;
    }
    setSaveState("error");
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

// Compliance (who's "out of compliance" and why) is derived server-side
// from *every* driver's current picks, not just this one's — so a save
// here can change what another driver's row should show. Refetching after
// a successful save is what makes that show up without a manual reload.
function saveUpgradeTrackerRow(driverId) {
  const row = DATA.upgradeTracker.entries.find((e) => e.driverId === driverId);
  scheduleSave(`upgrade-tracker:${driverId}`, async () => {
    try {
      await apiPut(`/api/upgrade-tracker/${driverId}${seasonQuery()}`, { sponsor: row.sponsor, upgrades: row.upgrades, modification: row.modification });
    } catch (err) {
      // A rejected pick (e.g. two of the same upgrade type) — flagged on
      // the row itself (see renderUpgradeTracker) rather than only in the
      // top-bar text, so it reads the same as an oversubscribed pick.
      // runSave still shows the generic save-failed indicator and, for a
      // 4xx, refetches DATA to revert the optimistic edit — this just
      // remembers why, since that revert would otherwise wipe any local
      // trace of it.
      if (err.status >= 400 && err.status < 500) upgradeTrackerRowErrors.set(driverId, err.message);
      throw err;
    }
    upgradeTrackerRowErrors.delete(driverId);
    await refreshData();
  });
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

function endSeason(seasonNumber) {
  return apiPost(`/api/season/${seasonNumber}/end`);
}

function reopenSeason(seasonNumber) {
  return apiPost(`/api/season/${seasonNumber}/reopen`);
}

function saveTechRegs() {
  scheduleSave("techregs", () => apiPut(`/api/techregs${seasonQuery()}`, { items: DATA.technicalRegulations }));
}

function saveFiccNotes() {
  scheduleSave("ficc-notes", () => apiPut(`/api/ficc/notes${seasonQuery()}`, { notes: DATA.ficcBacklog.notes }));
}

function saveFiccProposal(driverId) {
  const p = DATA.ficcBacklog.proposals.find((p) => p.driverId === driverId);
  scheduleSave(`ficc-proposal:${driverId}`, () =>
    apiPut(`/api/ficc/proposals/${driverId}${seasonQuery()}`, {
      regulationName: p.regulationName,
      explanation: p.explanation,
    })
  );
}

function saveFiccFreeform() {
  const driverRowCount = DATA.drivers.length;
  const freeform = DATA.ficcBacklog.proposals.slice(driverRowCount);
  scheduleSave("ficc-freeform", () => apiPut(`/api/ficc/proposals/freeform${seasonQuery()}`, { items: freeform }));
}

// ---------- Voting (FICC proposals + technical regulations) ----------
// Unlike the debounced scheduleSave() saves above, a vote/veto is a single
// discrete action, not a text field losing focus — it fires immediately,
// and refreshes the whole page's data afterward since a vote can resolve
// (and even auto-promote a regulation into next season) for everyone
// looking at this page, not just the voter.
function castFiccProposalVote(driverId, vote) {
  return apiPut(`/api/ficc/proposals/${driverId}/vote${seasonQuery()}`, { vote });
}
function castFiccProposalVeto(driverId) {
  return apiPost(`/api/ficc/proposals/${driverId}/veto${seasonQuery()}`);
}
function castFiccFreeformVote(id, vote) {
  return apiPut(`/api/ficc/proposals/freeform/${id}/vote${seasonQuery()}`, { vote });
}
function castFiccFreeformVeto(id) {
  return apiPost(`/api/ficc/proposals/freeform/${id}/veto${seasonQuery()}`);
}
function castTechRegVote(id, vote) {
  return apiPut(`/api/techregs/${id}/vote${seasonQuery()}`, { vote });
}
function castTechRegVeto(id) {
  return apiPost(`/api/techregs/${id}/veto${seasonQuery()}`);
}

async function handleVoteClick(castFn) {
  try {
    await castFn();
    await refreshData();
  } catch (err) {
    showErrorBanner("Could not cast vote", err.message);
  }
}

async function handleVetoClick(castFn) {
  if (!window.confirm("Use the season champion's one-time Golden Wrench veto on this item? It can only be used once per off-season, and can't be undone.")) return;
  try {
    await castFn();
    await refreshData();
  } catch (err) {
    showErrorBanner("Could not veto", err.message);
  }
}

// Whether the current viewer is allowed to see a veto button at all —
// the actual authorization is still enforced server-side, this just
// avoids showing the button to someone who'd only get a 403.
function canUseVeto() {
  return (
    !DATA.season.vetoUsedBy &&
    (isAdmin() || (CURRENT_USER?.driverId && CURRENT_USER.driverId === DATA.season.championDriverId))
  );
}

// Once a single vote has been cast, a proposal/regulation's content is
// frozen server-side (see isContentLocked in server/db/voting.js) — this
// mirrors that same rule client-side so editable fields just render as
// plain text instead of letting someone attempt an edit that's only
// going to be rejected on save.
function isVotingLocked(voting) {
  return !!voting && voting.votedCount > 0;
}

// Builds the compact voting UI for one votable item — participation count
// and Yes/No buttons while blind and open, a resolved-outcome pill once
// it isn't. `onVote`/`onVeto` are null when the current viewer isn't
// eligible for that action (not a driver, already voted, veto unavailable).
function renderVotingControl(voting, { onVote, onVeto }) {
  const wrap = h("div", { class: "voting-control" });
  if (!voting || !voting.votingOpen) {
    wrap.appendChild(h("span", { class: "muted" }, "—"));
    return wrap;
  }

  if (voting.status !== "open") {
    const label = voting.status === "passed" ? `Passed ${voting.yes}-${voting.no}` : voting.status === "vetoed" ? "Vetoed" : `Failed ${voting.yes}-${voting.no}`;
    wrap.appendChild(h("span", { class: "voting-pill voting-" + voting.status }, label));
    return wrap;
  }

  wrap.appendChild(h("div", { class: "muted voting-progress" }, `${voting.votedCount} of ${voting.totalVoters} voted`));
  if (voting.myVote) {
    wrap.appendChild(h("div", { class: "muted" }, `You voted ${voting.myVote === "yes" ? "Yes" : "No"}`));
  } else if (onVote) {
    const yesBtn = h("button", { class: "btn small" }, "Yes");
    const noBtn = h("button", { class: "btn small" }, "No");
    yesBtn.addEventListener("click", () => onVote("yes"));
    noBtn.addEventListener("click", () => onVote("no"));
    wrap.appendChild(h("div", { class: "voting-buttons" }, yesBtn, noBtn));
  }
  if (onVeto) {
    const vetoBtn = h("button", { class: "btn small voting-veto" }, "🔧 Veto");
    vetoBtn.addEventListener("click", onVeto);
    wrap.appendChild(vetoBtn);
  }
  return wrap;
}

// Wires renderVotingControl up to a specific votable item — shared by
// technical regulations and both kinds of FICC proposal rows, which only
// differ in which field identifies the item (a tech reg/freeform proposal
// has its own `id`; a driver-linked proposal is identified by `driverId`).
function buildVotingTd(item, vetoEligible, castVoteFn, castVetoFn, idField = "id") {
  const id = item[idField];
  const open = item.voting?.status === "open";
  const onVote = CURRENT_USER?.driverId && open && !item.voting?.myVote
    ? (vote) => handleVoteClick(() => castVoteFn(id, vote))
    : null;
  const onVeto = vetoEligible && open ? () => handleVetoClick(() => castVetoFn(id)) : null;
  return h("td", {}, renderVotingControl(item.voting, { onVote, onVeto }));
}

function saveOffseasonRegs() {
  scheduleSave("offseason-regs", () => apiPut("/api/offseason/regulations", { items: DATA.offSeasonBudget.regulations }));
}

function saveOffseasonWinnings(position, winnings) {
  scheduleSave(`offseason-winnings:${position}`, () => apiPut(`/api/offseason/winnings/${position}${seasonQuery()}`, { winnings }));
}

function saveHofMissedRaceLog() {
  scheduleSave("hof-missedrace", () => apiPut("/api/halloffame/missed-race-log", { items: DATA.hallOfFame.missedRaceLog }));
}

// Editing a part's stock (Count) changes everyone's availableCount and
// upgrade-tracker compliance, not just this row — refetch after saving so
// those derived values don't go stale until the next full reload.
function saveUpgradePart(partNumber, fields) {
  scheduleSave(`upgrade-part:${partNumber}`, async () => {
    await apiPut(`/api/admin/upgrade-parts/${partNumber}`, fields);
    await refreshData();
  });
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
// Mirrors server/db/ranking.js's compareRaceHistory — kept in sync by hand
// since there's no shared module between server and this plain <script>
// client. Ties on totalPoints are broken by comparing each driver's own
// race finishes best-to-worst; a missed race (null) counts as worse than
// any numeric finish.
function compareRaceHistory(racesA, racesB) {
  const sortedFinishes = (races) => [...(races || [])].map((p) => (p == null ? Infinity : p)).sort((x, y) => x - y);
  const a = sortedFinishes(racesA);
  const b = sortedFinishes(racesB);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const pa = a[i] ?? Infinity;
    const pb = b[i] ?? Infinity;
    if (pa !== pb) return pa - pb;
  }
  return 0;
}

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
  const sorted = [...DATA.standings.drivers].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    return compareRaceHistory(a.races, b.races);
  });
  let rank = 0, seen = 0, prev = null;
  for (const d of sorted) {
    seen++;
    const tiedWithPrev = prev != null && prev.totalPoints === d.totalPoints && compareRaceHistory(prev.races, d.races) === 0;
    if (!tiedWithPrev) rank = seen;
    d.position = rank;
    prev = d;
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
  // Sorted by current standing (1st place first), not roster order — since
  // this whole tab already re-renders from scratch after every race-result
  // or points-table edit (see the numberInput onChange calls below), this
  // keeps the table re-sorted live as soon as an edit changes anyone's
  // position, with no separate "resort" step needed.
  const sortedDrivers = [...DATA.standings.drivers].sort((a, b) => a.position - b.position);
  for (const d of sortedDrivers) {
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

  // Visible to everyone (so drivers can see the scoring rules), editable
  // only by admin.
  const panel2 = h("div", { class: "panel" });
  const details = h("details");
  details.appendChild(h("summary", {}, "Points-per-position lookup table" + (allowed ? " (edit to change scoring rules)" : "")));
  const table2 = h("table");
  table2.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Position"), h("th", {}, "Points"))));
  const tbody2 = h("tbody");
  DATA.standings.pointsTable.forEach((row) => {
    const tr = h("tr", { class: podiumClass("pos-ref-", row.position) });
    const tdPos = h("td");
    const tdPts = h("td");
    if (allowed) {
      tdPos.appendChild(numberInput(row.position, (v) => { row.position = v; recomputeStandings(); renderActive(); savePointsTable(); }));
      tdPts.appendChild(numberInput(row.points, (v) => { row.points = v; recomputeStandings(); renderActive(); savePointsTable(); }));
    } else {
      tdPos.appendChild(document.createTextNode(String(row.position)));
      tdPts.appendChild(document.createTextNode(String(row.points)));
    }
    tr.appendChild(tdPos); tr.appendChild(tdPts);
    tbody2.appendChild(tr);
  });
  table2.appendChild(tbody2);
  details.appendChild(table2);
  panel2.appendChild(details);
  container.appendChild(panel2);
}

// ---------- Race Results (read-only, race-by-race view of Standings' data) ----------
// Builds one race's finishing order, podium (top 3) visually separated
// from the rest of the field. Shared by the full tab and the Home bento
// card so both stay in sync with a single layout.
function buildRaceResultBlock(label, raceIndex) {
  const finishers = DATA.standings.drivers
    .filter((d) => d.races[raceIndex] != null)
    .map((d) => ({ driver: d.driver, pos: d.races[raceIndex] }))
    .sort((a, b) => a.pos - b.pos);

  const block = h("div", { class: "race-result-block" });
  block.appendChild(h("h3", {}, label));
  if (finishers.length === 0) {
    block.appendChild(h("p", { class: "muted" }, "No results yet."));
    return block;
  }

  const podium = finishers.filter((f) => f.pos <= 3);
  const rest = finishers.filter((f) => f.pos > 3);

  const podiumRow = h("div", { class: "race-podium" });
  podium.forEach((f) => {
    podiumRow.appendChild(
      h("div", { class: "race-podium-item" },
        h("span", { class: "race-podium-rank " + podiumClass("pos-", f.pos) }, ordinal(f.pos)),
        driverBadge(f.driver))
    );
  });
  block.appendChild(podiumRow);

  if (rest.length > 0) {
    const list = h("div", { class: "race-field-list" });
    rest.forEach((f) => {
      list.appendChild(
        h("div", { class: "race-field-row" }, h("span", { class: "race-field-pos" }, ordinal(f.pos)), driverBadge(f.driver))
      );
    });
    block.appendChild(list);
  }
  return block;
}

function renderRaceResults(container) {
  recomputeStandings();

  DATA.standings.raceLabels.forEach((label, i) => {
    const panel = h("div", { class: "panel" });
    panel.appendChild(buildRaceResultBlock(label || `Race ${i + 1}`, i));
    container.appendChild(panel);
  });
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
// A rejected car-color pick (someone else already holds it) is recorded as
// a client-only note on the driver object — not sent to the server, and
// dropped by the next refreshData() — so it survives re-renders instead of
// vanishing the moment you switch tabs. Cleared here too, defensively, any
// time the color it referenced is no longer held by anyone else (e.g. the
// admin just moved the other driver off it).
function reconcileColorConflicts() {
  for (const d of DATA.drivers) {
    if (d.colorConflict && !DATA.drivers.some((x) => x !== d && x.carColor === d.colorConflict.attempted)) {
      d.colorConflict = null;
    }
  }
}

function renderDrivers(container) {
  reconcileColorConflicts();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "1961 Driver Lineup"));
  const grid = h("div", { class: "driver-grid" });
  DATA.drivers.forEach((d) => {
    const allowed = isSelfOrAdmin(d.driverId);
    const card = h("div", { class: "driver-card" });
    card.style.setProperty("--car-color", carColorMap()[d.carColor] || "#888");

    // driverIndicator (dot, or the driver's own number if they've set one —
    // see numberBadge) alongside the team name, same as everywhere else a
    // driver's identity shows up (Standings, Upgrade Tracker, etc.).
    const header = h("div", { style: "display:flex; align-items:center; gap:8px; margin-bottom:8px;" });
    header.appendChild(driverIndicator(d));
    if (allowed) {
      const teamInput = textInput(d.teamName, (v) => { d.teamName = v; saveDriverFields(d.driverId, { teamName: v }); });
      teamInput.style.fontWeight = "700";
      teamInput.style.fontSize = "1.05rem";
      header.appendChild(teamInput);
    } else {
      header.appendChild(h("div", { style: "font-weight:700; font-size:1.05rem;" }, d.teamName));
    }
    card.appendChild(header);

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
      // Not restricted to unclaimed colors (unlike the Add Driver form) —
      // picking a taken one is allowed to attempt, it just won't save
      // (see the catch below and reconcileColorConflicts above).
      const colorSelect = selectInput(d.carColor, Object.keys(carColorMap()), async (v) => {
        const prevColor = d.carColor;
        d.colorConflict = null;
        try {
          await apiPut(`/api/drivers/${d.driverId}/car-color`, { carColor: v });
          d.carColor = v;
          reconcileColorConflicts(); // this driver vacating prevColor may clear someone else's note
        } catch (err) {
          colorSelect.value = prevColor;
          const holder = DATA.drivers.find((x) => x.carColor === v)?.driver || null;
          d.colorConflict = { attempted: v, holder, message: err.message };
        }
        renderActive();
      });
      card.appendChild(labeledField("Car Color", colorSelect));
      if (d.colorConflict) {
        card.appendChild(
          h("div", { class: "color-conflict-note" },
            h("span", { class: "compliance-icon" }, "!"),
            ` Tried to set color to "${d.colorConflict.attempted}"${d.colorConflict.holder ? `, but it's already used by ${d.colorConflict.holder}` : ""} — change their color first, then try again.`
          )
        );
      }
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
  const takenColors = new Set(DATA.drivers.map((d) => d.carColor).filter(Boolean));
  const availableColors = Object.keys(carColorMap()).filter((c) => !takenColors.has(c));
  const colorInput = selectInput("", [{ value: "", label: "— none —" }, ...availableColors], () => {});
  const backstoryInput = h("textarea", { rows: "2", placeholder: "Backstory (optional)" });

  const row = h("div", { style: "display:flex; gap:10px; margin-bottom:10px;" });
  row.appendChild(labeledField("Driver name", driverInput));
  row.appendChild(labeledField("Player name", playerInput));
  row.appendChild(labeledField("Team name", teamInput));
  row.appendChild(labeledField("Car color", colorInput));
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
        carColor: colorInput.value || null,
      });
      showCredentialsBanner(`Driver "${body.driver.driver}" created`, body.username, body.tempPassword);
      driverInput.value = ""; playerInput.value = ""; teamInput.value = ""; backstoryInput.value = ""; colorInput.value = "";
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
// Not gated on matchMedia("hover: hover") — that turned out to be an
// unreliable signal for "will a tap here actually work": it reports true
// on some hybrid trackpad+touchscreen devices, and (more commonly) on a
// plain desktop browser window just narrowed to a mobile width without
// real device/touch emulation turned on, and gating real functionality
// on it meant taps silently did nothing in exactly those cases. Instead,
// every card below uses Pointer Events and checks event.pointerType per
// interaction — "mouse" gets hover-to-preview (pointerenter/pointerleave),
// anything else (touch, pen, or a keyboard-triggered click, which reports
// no pointer type at all) gets tap-to-toggle instead. Checking per-event
// rather than guessing once per device is what lets both coexist without
// fighting: a mouse's real hover state is never confused with a touch tap
// that happens to also dispatch a synthetic hover-like event first.
function closeAllZoomWraps(except) {
  document.querySelectorAll(".upgrade-card-zoom-wrap.zoom-open").forEach((el) => {
    if (el !== except) el.classList.remove("zoom-open");
  });
}
// Tapping/clicking anywhere that isn't a zoom trigger closes whatever's
// open. Tapping a trigger itself is handled by attachZoomCard below,
// which runs first (pointerup fires, then click bubbles here) and closes
// via its own toggle if the trigger's already open — so this only ever
// needs to handle "somewhere else entirely" and never fights that toggle.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".upgrade-zoom-trigger")) closeAllZoomWraps(null);
});

// Builds an always-visible 84px thumbnail wrapped in a hover/tap zoom
// trigger (see attachZoomCard below) — shared by every "card art" spot
// (Upgrade Tracker part cells and sponsor cell, Inventory's part/sponsor
// detail rows) so they all zoom the same way. Returns null instead of a
// broken image when there's no image path at all (e.g. a sponsor with no
// mapped card art — see sponsorCardImagePath) — callers skip the whole
// card-art wrapper in that case rather than showing an empty one.
function buildCardThumb(imageSrc, altText) {
  if (!imageSrc) return null;
  const thumb = h("img", { class: "upgrade-card-thumb", src: imageSrc, alt: altText, loading: "lazy" });
  thumb.addEventListener("error", () => { thumb.style.display = "none"; });
  const thumbTrigger = h("div", { class: "upgrade-card-thumb-trigger" }, thumb);
  attachZoomCard(thumbTrigger, imageSrc, altText);
  return thumbTrigger;
}

// Adds the actual zoomable card art to `triggerEl`, which must be the
// element the card should pop out from — either an always-visible 84px
// thumbnail (Upgrade Tracker page) or a part-number badge with no
// visible thumbnail at all (Home page). The popup (.upgrade-card-zoom-wrap
// in style.css) is appended to <body>, not to `triggerEl` — a descendant
// of a stacking-context-creating ancestor (e.g. the Home page's bento
// cards, which use `isolation: isolate` for their own hover-gradient
// effect) has its z-index trapped inside that ancestor's own local stack,
// no matter how high the number is, which is why it was rendering under
// the topbar there. Being a direct child of <body> sidesteps that
// entirely. Shown/hidden and positioned purely via JS as a result (no
// CSS :hover needed for it at all).
function attachZoomCard(triggerEl, imageSrc, altText) {
  triggerEl.classList.add("upgrade-zoom-trigger");
  const img = h("img", { src: imageSrc, alt: altText, loading: "lazy" });
  img.addEventListener("error", () => { img.style.display = "none"; });
  const zoomWrap = h("div", { class: "upgrade-card-zoom-wrap" }, img);
  document.body.appendChild(zoomWrap);

  // Centers the popup on the trigger's actual on-screen box, computed
  // fresh each time — exact regardless of ancestor layout. See the paired
  // "translate(-50%, -50%) scale(3)" in style.css, which centers the
  // (differently-sized) zoomed box on this same point. On a touch tap
  // (see the pointerup handler below) we instead center on the viewport:
  // at 3x scale, a card zoomed in place from a thumbnail near the edge of
  // a narrow phone screen mostly renders off-screen, whereas the trigger's
  // own position is irrelevant to a tap (there's no cursor to stay under).
  const positionZoom = (centerOnScreen) => {
    if (centerOnScreen) {
      zoomWrap.style.left = `${window.innerWidth / 2}px`;
      zoomWrap.style.top = `${window.innerHeight / 2}px`;
      return;
    }
    const rect = triggerEl.getBoundingClientRect();
    zoomWrap.style.left = `${rect.left + rect.width / 2}px`;
    zoomWrap.style.top = `${rect.top + rect.height / 2}px`;
  };

  triggerEl.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    positionZoom(false);
    zoomWrap.classList.add("zoom-open");
  });
  triggerEl.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    zoomWrap.classList.remove("zoom-open");
  });
  // pointerup (not click) — a genuine PointerEvent, so pointerType is
  // always reliably set, unlike on the click event that follows it.
  triggerEl.addEventListener("pointerup", (e) => {
    if (e.target.closest("select, input, button, a")) return;
    if (e.pointerType === "mouse") return; // mice already get hover above
    const wasOpen = zoomWrap.classList.contains("zoom-open");
    closeAllZoomWraps(zoomWrap);
    zoomWrap.classList.toggle("zoom-open", !wasOpen);
    if (!wasOpen) positionZoom(true);
  });
}

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
    // e.carryover itself is never recomputed client-side — it's whatever
    // the server last sent (live-computed from the prior season, or a
    // frozen snapshot if that season's ended); this just keeps it
    // folded into the locally-recomputed budget after a sponsor/modification edit.
    e.budget = (DATA.season.baseTeamBudget || 0) + computeSponsorFunding(e.sponsor) + (e.modification || 0) + (e.carryover || 0);
    const spent = e.upgrades.reduce((sum, p) => sum + (p != null ? computeUpgradeCost(p) : 0), 0);
    e.remainingBudget = e.budget - spent;
  });
}

function renderUpgradeTracker(container) {
  recomputeUpgradeTracker();
  const admin = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Upgrade Tracker — Current Season"));
  if (DATA.upgradeTracker.rule) panel.appendChild(h("p", { class: "muted panel-note" }, DATA.upgradeTracker.rule));
  if (!admin) panel.appendChild(h("p", { class: "muted panel-note" }, "Modification is managed by the league admin. Drivers can select their own sponsor and upgrade parts below."));
  const wrap = h("div", { class: "table-scroll" });
  const table = h("table");
  const headRow = h("tr", {}, h("th", { class: "upgrade-row-toggle-col" }), h("th", {}, "Driver"), h("th", {}, "Sponsor"), h("th", {}, "Budget"), h("th", {}, "Carryover"));
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) headRow.appendChild(h("th", {}, `Upgrade ${i + 1}`));
  headRow.appendChild(h("th", {}, "Modification"));
  headRow.appendChild(h("th", {}, "Remaining"));
  table.appendChild(h("thead", {}, headRow));
  const tbody = h("tbody");
  const sponsorNames = DATA.inventory.sponsors.map((s) => s.name);
  for (const e of DATA.upgradeTracker.entries) {
    const tr = h("tr", { class: "upgrade-row" });
    const toggleRow = () => {
      tr.classList.toggle("open");
      // Any zoomed card popup is a body-level floating element with no
      // DOM relationship to this row (see attachZoomCard) — closing on
      // any row open/close avoids one being left floating with no
      // visible row underneath it.
      closeAllZoomWraps(null);
    };
    // Not gated on hover support — always attached so a tap always works.
    // Harmless for real mouse users too: :hover already reveals the row
    // on its own, and a stray click just sets the same .open state
    // :hover would've implied anyway. In practice a <tr> (not a
    // naturally interactive element, unlike a real <button>) doesn't
    // reliably fire click from a tap on every touch browser, so this is
    // a secondary path — the toggle button below (visible on narrow
    // viewports; see .upgrade-row-toggle-col in style.css) is the
    // primary, guaranteed-reliable one for mobile.
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("select, input, button, a, .upgrade-zoom-trigger")) return;
      toggleRow();
    });
    const toggleBtn = h("button", { class: "upgrade-row-toggle", type: "button", "aria-label": "Toggle upgrade cards" }, h("span", {}, "▸"));
    toggleBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleRow();
    });
    tr.appendChild(h("td", { class: "upgrade-row-toggle-col" }, toggleBtn));
    tr.appendChild(h("td", {}, driverBadge(e.driver)));
    // A driver can pick their own sponsor and upgrade parts (admin can pick
    // anyone's); modification stays admin-only below. No two drivers can
    // hold the same sponsor — like an oversubscribed upgrade part, a
    // conflicting pick still saves and shows up as the same "!" row flag
    // (see e.complianceIssues, computeSponsorCompliance in
    // server/db/priority.js) rather than being blocked outright.
    const canPickUpgrades = isSelfOrAdmin(e.driverId);
    const sponsorTd = h("td");
    const sponsorCell = h("div", { class: "upgrade-cell" });
    if (canPickUpgrades) {
      sponsorCell.appendChild(selectInput(e.sponsor, ["", ...sponsorNames], (v) => { e.sponsor = v || null; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
    } else {
      sponsorCell.appendChild(document.createTextNode(e.sponsor || "—"));
    }
    if (e.sponsor) {
      // Same hover/tap-to-reveal card art as an upgrade slot (shared
      // .upgrade-cell-card-wrap/-inner classes, so it opens with the same
      // row hover/.open state — see the CSS comment on .upgrade-cell-card-wrap).
      const thumbTrigger = buildCardThumb(sponsorCardImagePath(e.sponsor), `${e.sponsor} sponsor card`);
      if (thumbTrigger) {
        const cardInner = h("div", { class: "upgrade-cell-card-inner" },
          thumbTrigger,
          h("div", { class: "upgrade-card-label" }, e.sponsor)
        );
        sponsorCell.appendChild(h("div", { class: "upgrade-cell-card-wrap" }, cardInner));
      }
    }
    sponsorTd.appendChild(sponsorCell);
    tr.appendChild(sponsorTd);
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.budget)));
    // Rolled forward from the prior season's remaining budget + winnings —
    // computed, not editable by anyone (see computeCarryoverByDriver in
    // server/db/assemble.js).
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.carryover)));
    e.upgrades.forEach((val, i) => {
      const td = h("td");
      const cell = h("div", { class: "upgrade-cell" });
      if (canPickUpgrades) {
        cell.appendChild(upgradeSelect(val, (v) => { e.upgrades[i] = v; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
      } else {
        const u = DATA.inventory.upgrades.find((u) => u.partNumber === Number(val));
        cell.appendChild(document.createTextNode(val != null ? `#${val}${u ? " · " + u.type : ""}` : "—"));
      }
      if (val != null) {
        const u = DATA.inventory.upgrades.find((u) => u.partNumber === Number(val));
        const thumbTrigger = buildCardThumb(partCardImagePath(val), `Part #${val} card`);
        if (thumbTrigger) {
          const cardInner = h("div", { class: "upgrade-cell-card-inner" },
            thumbTrigger,
            h("div", { class: "upgrade-card-label" }, `#${val}${u ? " · " + u.type : ""}`)
          );
          cell.appendChild(h("div", { class: "upgrade-cell-card-wrap" }, cardInner));
        }
      }
      td.appendChild(cell);
      tr.appendChild(td);
    });
    const modTd = h("td");
    if (admin) {
      modTd.appendChild(numberInput(e.modification, (v) => { e.modification = v; recomputeUpgradeTracker(); renderActive(); saveUpgradeTrackerRow(e.driverId); }));
    } else {
      modTd.appendChild(document.createTextNode(String(e.modification ?? 0)));
    }
    tr.appendChild(modTd);
    tr.appendChild(h("td", { class: "cell-computed" }, fmtMoney(e.remainingBudget)));
    const rowError = upgradeTrackerRowErrors.get(e.driverId);
    if (e.outOfCompliance || rowError) tr.classList.add("row-noncompliant");
    tbody.appendChild(tr);

    // Same "!" detail-row treatment for both kinds of Upgrade Tracker
    // error — an oversubscribed pick (allowed to save, flagged after the
    // fact) and a rejected pick like two of the same upgrade type (never
    // saved at all, see saveUpgradeTrackerRow) — so they read the same way
    // regardless of which check caught it.
    if (e.outOfCompliance) {
      const message = e.complianceIssues
        .map((issue) => issue.sponsor != null
          ? `Sponsor "${issue.sponsor}" is oversubscribed — ${issue.higherPriorityCount} higher-priority driver(s) also claimed it.`
          : `Part #${issue.partNumber} (${issue.partType}) is oversubscribed — ${issue.higherPriorityCount} higher-priority driver(s) also selected it.`)
        .join(" ");
      const detailTd = h("td", { colspan: String(7 + MAX_UPGRADE_SLOTS) }, h("span", { class: "compliance-icon" }, "!"), " " + message);
      tbody.appendChild(h("tr", { class: "compliance-detail-row" }, detailTd));
    }
    if (rowError) {
      const detailTd = h("td", { colspan: String(7 + MAX_UPGRADE_SLOTS) }, h("span", { class: "compliance-icon" }, "!"), " " + rowError);
      tbody.appendChild(h("tr", { class: "compliance-detail-row" }, detailTd));
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  container.appendChild(panel);

  renderCardRestrictions(container);
}

// Season rule config for which upgrade parts are pickable at all — an
// inclusion list for tiers (empty = no restriction) and an exclusion list
// for types (empty = none banned), stored on the SEASON item since future
// seasons are expected to set different rules. Visible to everyone (so
// drivers know why a part is missing from their dropdown), editable only
// by admin. upgradeSelect() is what actually applies these.
function saveCardRestrictions(fields) {
  saveSeasonField(fields);
}

function renderCardRestrictions(container) {
  const admin = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Card Restrictions"));
  panel.appendChild(h("p", { class: "muted panel-note" },
    admin
      ? "Uncheck a tier or type to remove it from everyone's Upgrade Tracker dropdowns this season."
      : "Season rules set by the league admin — unchecked tiers/types don't appear as Upgrade Tracker options."
  ));

  // Same tier ranking as the Upgrade Tracker dropdowns (S first), not
  // alphabetical — alphabetical order would put "A" before "S".
  const tiers = [...new Set(DATA.inventory.upgrades.map((u) => String(u.tier)))]
    .sort((a, b) => (TIER_RANK[a] ?? 6) - (TIER_RANK[b] ?? 6));
  const types = [...new Set(DATA.inventory.upgrades.map((u) => u.type))].sort();
  const allowedTiers = new Set(DATA.season.allowedTiers && DATA.season.allowedTiers.length ? DATA.season.allowedTiers : tiers);
  const disallowedTypes = new Set(DATA.season.disallowedTypes || []);

  // Every checkbox here means "checked = currently allowed", regardless of
  // whether it's backed by an inclusion list (tiers) or exclusion list
  // (types) — keeps the two rows consistent to read even though they're
  // stored as opposite kinds of list.
  function checkboxRow(label, options, isAllowed, setAllowed) {
    const row = h("div", { class: "restriction-row" });
    row.appendChild(h("div", { class: "restriction-row-label" }, label));
    const list = h("div", { class: "restriction-checkboxes" });
    for (const opt of options) {
      const lbl = h("label", { class: "restriction-checkbox" });
      const cb = checkboxInput(isAllowed(opt), (checked) => setAllowed(opt, checked));
      if (!admin) cb.disabled = true;
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(opt));
      list.appendChild(lbl);
    }
    row.appendChild(list);
    return row;
  }

  panel.appendChild(checkboxRow("Tiers", tiers, (t) => allowedTiers.has(t), (t, checked) => {
    if (checked) allowedTiers.add(t); else allowedTiers.delete(t);
    DATA.season.allowedTiers = [...allowedTiers];
    renderActive();
    saveCardRestrictions({ allowedTiers: DATA.season.allowedTiers });
  }));

  panel.appendChild(checkboxRow("Types", types, (t) => !disallowedTypes.has(t), (t, checked) => {
    if (checked) disallowedTypes.delete(t); else disallowedTypes.add(t);
    DATA.season.disallowedTypes = [...disallowedTypes];
    renderActive();
    saveCardRestrictions({ disallowedTypes: DATA.season.disallowedTypes });
  }));

  container.appendChild(panel);
}

// ---------- Inventory ----------
// Admin can edit existing rows (adding/removing parts or sponsors isn't
// wired up yet); drivers see the same table read-only.
const invFilter = { search: "", type: "", tier: "" };
// Part numbers whose card image is currently expanded — module-level so the
// open/closed state survives a filter change or an admin edit, both of
// which call renderInventoryTableInto() and rebuild every row from scratch.
const invExpanded = new Set();
// Same idea as invExpanded above, but for the Sponsors table's card-art
// detail rows — keyed by sponsorId since that's sponsors' stable
// identifier (see saveSponsor).
const sponsorInvExpanded = new Set();
// Current column sort — key is null until a header is clicked, meaning
// "server order" (by partNumber). Not persisted across page loads.
const invSort = { key: null, dir: 1 };
// Conventional tier ranking (best to worst) for sorting; anything outside
// this set (e.g. an unranked "x") sorts after all known tiers.
const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

function partCardImagePath(partNumber) {
  return `/images/cards/${partNumber}_cropped.png`;
}

// Unlike upgrade parts (whose card art is filed by partNumber — a stable
// identifier every part already has), sponsor card art has no such ID to
// key off, so each file was named by hand from a short, distinctive word
// in that sponsor's name. Keyed by sponsor name because that's the only
// identifier every call site already has on hand (an upgradeTracker
// entry's `sponsor` field is a name string, not the Inventory page's
// sponsorId — see saveUpgradeTrackerRow). Returns null (not a guessed
// path) for a sponsor with no mapped art — buildCardThumb skips the
// card-art wrapper entirely rather than showing a broken image.
const SPONSOR_CARD_IMAGE_SLUGS = {
  "Eole Wing Industries": "eole",
  "Fredo&F": "fredo",
  "Dramdo": "dramdo",
  "Lord & CO": "lord",
  "De Angeli": "de_angli",
  "E. Mercury Air System": "mercury",
  "Thunder Valley Aero": "thunder_valley",
  "Aperault": "aperault",
  "Moquette": "moquette",
  "Beewee": "beewee",
  "Noctie": "noctie",
};
function sponsorCardImagePath(sponsorName) {
  const slug = SPONSOR_CARD_IMAGE_SLUGS[sponsorName];
  return slug ? `/images/cards/${slug}_cropped.png` : null;
}

function invSortedRows(rows) {
  if (!invSort.key) return rows;
  const { key, dir } = invSort;
  const sorted = [...rows].sort((a, b) => {
    if (key === "type") return String(a.type).localeCompare(String(b.type)) * dir;
    if (key === "partNumber") return (a.partNumber - b.partNumber) * dir;
    if (key === "tier") {
      const rankA = TIER_RANK[a.tier] ?? 6, rankB = TIER_RANK[b.tier] ?? 6;
      return (rankA - rankB || String(a.tier).localeCompare(String(b.tier))) * dir;
    }
    if (key === "cost") {
      const costA = typeof a.cost === "number" ? a.cost : -Infinity;
      const costB = typeof b.cost === "number" ? b.cost : -Infinity;
      return (costA - costB) * dir;
    }
    if (key === "availableCount") {
      const availA = a.availableCount ?? a.countAvailable ?? 0;
      const availB = b.availableCount ?? b.countAvailable ?? 0;
      return (availA - availB) * dir;
    }
    return 0;
  });
  return sorted;
}

function renderInventoryTableInto(holder) {
  holder.innerHTML = "";
  const allowed = isAdmin();
  const table = h("table");
  function sortableHeader(label, key) {
    const active = invSort.key === key;
    const th = h("th", { class: "sortable" + (active ? " sorted" : "") }, label + (active ? (invSort.dir === 1 ? " ▲" : " ▼") : ""));
    th.addEventListener("click", () => {
      if (invSort.key === key) invSort.dir *= -1; else { invSort.key = key; invSort.dir = 1; }
      renderInventoryTableInto(holder);
    });
    return th;
  }
  table.appendChild(h("thead", {}, h("tr", {},
    h("th", { class: "inv-chevron-col" }),
    sortableHeader("Type", "type"),
    sortableHeader("Part #", "partNumber"),
    h("th", {}, "Count"),
    sortableHeader("Available", "availableCount"),
    sortableHeader("Tier", "tier"),
    sortableHeader("Cost", "cost")
  )));
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
  for (const u of invSortedRows(filtered)) {
    const tr = h("tr", { class: "inv-row" });
    const chevronTd = h("td", { class: "inv-chevron-col" }, h("span", { class: "inv-chevron" }, "▸"));
    const partTd = h("td", { class: "cell-computed inv-part" }, `#${u.partNumber}`);
    const available = u.availableCount ?? u.countAvailable ?? 0;
    tr.appendChild(chevronTd);
    if (allowed) {
      const tdType = h("td"); tdType.appendChild(textInput(u.type, (v) => { u.type = v; saveUpgradePart(u.partNumber, { type: v }); }));
      tr.appendChild(tdType);
      tr.appendChild(partTd);
      const tdCount = h("td");
      tdCount.appendChild(numberInput(u.countAvailable, (v) => { u.countAvailable = v; saveUpgradePart(u.partNumber, { countAvailable: v }); }));
      tr.appendChild(tdCount);
      // Available is purely derived (stock minus however many drivers have
      // currently selected this part) — no one edits it directly, ever.
      tr.appendChild(h("td", { class: available === 0 ? "inv-depleted" : "" }, String(available)));
      const tdTier = h("td");
      const tierInput = textInput(u.tier, (v) => { u.tier = v; saveUpgradePart(u.partNumber, { tier: v }); renderInventoryTableInto(holder); });
      tierInput.classList.add("tier-" + u.tier);
      tdTier.appendChild(tierInput);
      tr.appendChild(tdTier);
      const tdCost = h("td"); tdCost.appendChild(numberInput(typeof u.cost === "number" ? u.cost : null, (v) => { u.cost = v; saveUpgradePart(u.partNumber, { cost: v }); }));
      tr.appendChild(tdCost);
    } else {
      tr.appendChild(h("td", {}, u.type));
      tr.appendChild(partTd);
      tr.appendChild(h("td", {}, String(u.countAvailable ?? "")));
      tr.appendChild(h("td", { class: available === 0 ? "inv-depleted" : "" }, String(available)));
      tr.appendChild(h("td", {}, h("span", { class: "badge tier-" + u.tier }, String(u.tier))));
      tr.appendChild(h("td", {}, typeof u.cost === "number" ? fmtMoney(u.cost) : String(u.cost)));
    }
    tbody.appendChild(tr);

    const detailInner = h("div", { class: "inv-detail-inner" });
    const img = h("img", { src: partCardImagePath(u.partNumber), alt: `Part #${u.partNumber} card`, loading: "lazy" });
    img.addEventListener("error", () => {
      detailInner.innerHTML = "";
      detailInner.appendChild(h("p", { class: "muted" }, "No card image available."));
    });
    detailInner.appendChild(img);
    const detailWrap = h("div", { class: "inv-detail" }, detailInner);
    const detailTd = h("td", { colspan: "7" }, detailWrap);
    const detailTr = h("tr", { class: "inv-detail-row" }, detailTd);
    tbody.appendChild(detailTr);

    if (invExpanded.has(u.partNumber)) {
      tr.classList.add("open");
      detailWrap.classList.add("open");
    }
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input, select, button, a")) return;
      const open = !invExpanded.has(u.partNumber);
      if (open) invExpanded.add(u.partNumber); else invExpanded.delete(u.partNumber);
      tr.classList.toggle("open", open);
      detailWrap.classList.toggle("open", open);
    });
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
  const typeSel = selectInput(invFilter.type, ["All", ...types], (v) => { invFilter.type = v === "All" ? "" : v; renderInventoryTableInto(holder); });
  const tierSel = selectInput(invFilter.tier, ["All", ...tiers], (v) => { invFilter.tier = v === "All" ? "" : v; renderInventoryTableInto(holder); });
  filters.appendChild(searchInp); filters.appendChild(typeSel); filters.appendChild(tierSel);
  panel.appendChild(filters);
  const holder = h("div", { class: "table-scroll" });
  panel.appendChild(holder);
  container.appendChild(panel);
  renderInventoryTableInto(holder);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Sponsors"));
  const table2 = h("table");
  table2.appendChild(h("thead", {}, h("tr", {}, h("th", { class: "inv-chevron-col" }), h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Count"), h("th", {}, "Funding"))));
  const tbody2 = h("tbody");
  DATA.inventory.sponsors.forEach((s) => {
    const tr = h("tr", { class: "inv-row" });
    // Same chevron-column trick as the Upgrade Parts table above: every
    // other Sponsors column becomes a text/number input for admin, so
    // without a dedicated non-input cell there'd be no click target left
    // that isn't itself an editable field.
    const chevronTd = h("td", { class: "inv-chevron-col" }, h("span", { class: "inv-chevron" }, "▸"));
    tr.appendChild(chevronTd);
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

    // Same click-to-expand card-art row as the Upgrade Parts table above.
    const detailInner = h("div", { class: "inv-detail-inner" });
    const img = h("img", { src: sponsorCardImagePath(s.name), alt: `${s.name} sponsor card`, loading: "lazy" });
    img.addEventListener("error", () => {
      detailInner.innerHTML = "";
      detailInner.appendChild(h("p", { class: "muted" }, "No card image available."));
    });
    detailInner.appendChild(img);
    const detailWrap = h("div", { class: "inv-detail" }, detailInner);
    const detailTd = h("td", { colspan: "5" }, detailWrap);
    tbody2.appendChild(h("tr", { class: "inv-detail-row" }, detailTd));

    if (sponsorInvExpanded.has(s.sponsorId)) {
      tr.classList.add("open");
      detailWrap.classList.add("open");
    }
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input, select, button, a")) return;
      const open = !sponsorInvExpanded.has(s.sponsorId);
      if (open) sponsorInvExpanded.add(s.sponsorId); else sponsorInvExpanded.delete(s.sponsorId);
      tr.classList.toggle("open", open);
      detailWrap.classList.toggle("open", open);
    });
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
      isCurrent ? h("strong", { style: "color:var(--good);" }, "this is the current season") : h("span", { class: "muted" }, `current season is #${DATA.currentSeasonNumber}`),
      s.ended ? h("span", { class: "muted" }, " · ended") : null
    )
  );
  const statusActions = h("div", { style: "display:flex; gap:8px;" });
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
    statusActions.appendChild(setCurrentBtn);
  }
  if (allowed && !s.ended) {
    const endBtn = h("button", { class: "btn small" }, "End Season");
    endBtn.addEventListener("click", async () => {
      if (!window.confirm(
        `End season #${DATA.viewedSeasonNumber} (${s.label})? This freezes every driver's budget rollover into the next season at today's numbers, and opens FICC backlog / technical regulation voting for the off-season. You can reopen the season later if needed, but any votes already cast in the meantime stay recorded and pick back up rather than resetting.`
      )) return;
      endBtn.disabled = true;
      try {
        await endSeason(DATA.viewedSeasonNumber);
        await refreshData();
      } catch (err) {
        showErrorBanner("Could not end season", err.message);
        endBtn.disabled = false;
      }
    });
    statusActions.appendChild(endBtn);
  }
  if (allowed && s.ended) {
    const reopenBtn = h("button", { class: "btn small" }, "Reopen season");
    reopenBtn.addEventListener("click", async () => {
      if (!window.confirm(
        `Reopen season #${DATA.viewedSeasonNumber} (${s.label})? Its budget carryover into the next season goes back to tracking this season live instead of the frozen snapshot, and FICC/tech-reg voting for this off-season closes again until you end it once more.`
      )) return;
      reopenBtn.disabled = true;
      try {
        await reopenSeason(DATA.viewedSeasonNumber);
        await refreshData();
      } catch (err) {
        showErrorBanner("Could not reopen season", err.message);
        reopenBtn.disabled = false;
      }
    });
    statusActions.appendChild(reopenBtn);
  }
  statusLine.appendChild(statusActions);
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
    addKV("Upgrade slots this season", numberInput(s.upgradeSlots, (v) => { s.upgradeSlots = v; saveSeasonField({ upgradeSlots: v }); normalizeData(); }));
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
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Regulation"), h("th", {}, "Explanation"), h("th", {}, "Voting"), h("th", {}, ""))));
  const tbody = h("tbody");
  const vetoEligible = canUseVeto();
  DATA.technicalRegulations.forEach((r, i) => {
    const tr = h("tr");
    const editable = allowed && !isVotingLocked(r.voting);
    if (editable) {
      const tdName = h("td"); tdName.appendChild(textInput(r.name, (v) => { r.name = v; saveTechRegs(); }));
      const tdExp = h("td"); tdExp.appendChild(textareaInput(r.explanation, (v) => { r.explanation = v; saveTechRegs(); }, 2));
      const tdDel = h("td");
      const b = h("button", { class: "btn small" }, "✕");
      b.addEventListener("click", () => { DATA.technicalRegulations.splice(i, 1); saveTechRegs(); renderActive(); });
      tdDel.appendChild(b);
      tr.appendChild(tdName); tr.appendChild(tdExp);
      tr.appendChild(buildVotingTd(r, vetoEligible, castTechRegVote, castTechRegVeto));
      tr.appendChild(tdDel);
    } else {
      tr.appendChild(h("td", {}, r.name));
      tr.appendChild(h("td", {}, r.explanation));
      tr.appendChild(buildVotingTd(r, vetoEligible, castTechRegVote, castTechRegVeto));
      tr.appendChild(h("td", {}));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (allowed) {
    const addBtn = h("button", { class: "btn" }, "+ Add regulation");
    addBtn.addEventListener("click", () => { DATA.technicalRegulations.push({ name: "", explanation: "" }); saveTechRegs(); renderActive(); });
    panel.appendChild(addBtn);
  }
  container.appendChild(panel);
}

// ---------- FICC Backlog ----------
function renderFiccBacklog(container) {
  const notesAllowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "FICC Rules Backlog"));
  if (notesAllowed) {
    panel.appendChild(textareaInput(DATA.ficcBacklog.notes, (v) => { DATA.ficcBacklog.notes = v; saveFiccNotes(); }, 4));
  } else if (DATA.ficcBacklog.notes) {
    panel.appendChild(h("p", { class: "muted", style: "white-space: pre-wrap;" }, DATA.ficcBacklog.notes));
  }
  container.appendChild(panel);

  const panel2 = h("div", { class: "panel" });
  panel2.appendChild(h("h2", {}, "Proposed Regulations"));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Proposed Regulation"), h("th", {}, "Explanation"), h("th", {}, "Voting"), h("th", {}, ""))));
  const tbody = h("tbody");
  const vetoEligible = canUseVeto();
  // The first N proposal rows are INDEX'd from the driver lineup in the sheet
  // (one proposal slot per driver) — driver-owned-editable, like the Drivers
  // tab. The remaining freeform rows are admin-only.
  const driverRowCount = DATA.drivers.length;
  DATA.ficcBacklog.proposals.forEach((p, i) => {
    const isDriverRow = i < driverRowCount;
    if (isDriverRow) p.driverName = DATA.drivers[i]?.driver ?? p.driverName;
    const rowAllowed = (isDriverRow ? isSelfOrAdmin(p.driverId) : isAdmin()) && !isVotingLocked(p.voting);
    const tr = h("tr");
    const tdDriver = h("td");
    if (isDriverRow) {
      tdDriver.appendChild(driverBadge(p.driverName));
    } else if (isAdmin() && !isVotingLocked(p.voting)) {
      tdDriver.appendChild(driverSelectField(p.driverName, (v) => { p.driverName = v || null; saveFiccFreeform(); }));
    } else {
      tdDriver.appendChild(document.createTextNode(p.driverName || ""));
    }
    const onProposalChange = isDriverRow ? () => saveFiccProposal(p.driverId) : () => saveFiccFreeform();
    if (rowAllowed) {
      const tdReg = h("td"); tdReg.appendChild(textInput(p.regulationName, (v) => { p.regulationName = v; onProposalChange(); }));
      const tdExp = h("td"); tdExp.appendChild(textareaInput(p.explanation, (v) => { p.explanation = v; onProposalChange(); }, 2));
      tr.appendChild(tdDriver); tr.appendChild(tdReg); tr.appendChild(tdExp);
    } else {
      tr.appendChild(tdDriver);
      tr.appendChild(h("td", {}, p.regulationName || ""));
      tr.appendChild(h("td", {}, p.explanation || ""));
    }
    tr.appendChild(
      isDriverRow
        ? buildVotingTd(p, vetoEligible, castFiccProposalVote, castFiccProposalVeto, "driverId")
        : buildVotingTd(p, vetoEligible, castFiccFreeformVote, castFiccFreeformVeto, "id")
    );
    const tdDel = h("td");
    if (!isDriverRow && isAdmin() && !isVotingLocked(p.voting)) {
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
    addBtn.addEventListener("click", () => { DATA.ficcBacklog.proposals.push({ driverName: null, regulationName: "", explanation: "" }); saveFiccFreeform(); renderActive(); });
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

  // Deterministic, one row per current driver, ordered by this season's
  // final standing — unlike the freeform trackers below, every driver
  // always has exactly one row here, so it's unambiguous who gets what.
  // The winnings amount is tied to the position (w.position), not the
  // driver occupying it — saveOffseasonWinnings saves by position, so if
  // standings change later, the amount stays with the position and
  // reactively follows whoever now holds it. This is what season creation
  // reads to seed next season's starting budget (see POST /api/season in
  // server/routes/season.routes.js).
  const winPanel = h("div", { class: "panel" });
  winPanel.appendChild(h("h2", {}, "Season-End Winnings"));
  winPanel.appendChild(h("p", { class: "muted panel-note" },
    "One row per driver, ordered by this season's final standing — winnings are tied to the position, so they follow whoever holds it if standings change. Feeds next season's starting budget when a new season is created."
  ));
  const winTable = h("table");
  winTable.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Pos"), h("th", {}, "Driver"), h("th", {}, "Winnings"))));
  const winTbody = h("tbody");
  DATA.offSeasonBudget.winningsByDriver.forEach((w) => {
    const tr = h("tr");
    tr.appendChild(h("td", { class: "cell-computed " + podiumClass("pos-", w.position) }, String(w.position)));
    tr.appendChild(h("td", {}, driverBadge(w.driver)));
    const tdWin = h("td");
    if (allowed) {
      tdWin.appendChild(numberInput(w.winnings, (v) => { w.winnings = v; saveOffseasonWinnings(w.position, v); }));
    } else {
      tdWin.appendChild(document.createTextNode(typeof w.winnings === "number" ? fmtMoney(w.winnings) : "—"));
    }
    tr.appendChild(tdWin);
    winTbody.appendChild(tr);
  });
  winTable.appendChild(winTbody);
  winPanel.appendChild(winTable);
  container.appendChild(winPanel);
}

// ---------- Hall of Fame ----------
function renderHallOfFame(container) {
  const allowed = isAdmin();
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Season-by-Season Champion Log"));
  panel.appendChild(h("p", { class: "muted panel-note" }, "Auto-populated from final standings once a season is ended — nothing to edit here."));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Season"), h("th", {}, "Driver's Champion"), h("th", {}, "Constructor's Champion"))));
  const tbody = h("tbody");
  DATA.hallOfFame.seasonLog.forEach((row) => {
    const tr = h("tr");
    tr.appendChild(h("td", { class: "cell-computed" }, String(row.season)));
    tr.appendChild(h("td", {}, row.champion || ""));
    tr.appendChild(h("td", {}, row.constructorChampion || ""));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  container.appendChild(panel);

  container.appendChild(genericTrackerPanel(
    "Hall of Lame (Missed Race Log)",
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

// ---------- Audit Log (admin only) ----------
// Read-only — entries are written server-side by every repo.js write path,
// not by any client action, so there's nothing here to save.
function fmtAuditValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function renderAuditLog(container) {
  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Audit Log"));
  panel.appendChild(h("p", { class: "muted panel-note" }, "Every database write, newest first — who changed what, and the before/after values."));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "Action"), h("th", {}, "Record"), h("th", {}, "Changes"))));
  const tbody = h("tbody");
  table.appendChild(tbody);
  panel.appendChild(table);
  container.appendChild(panel);

  apiGet("/api/admin/audit-log")
    .then(({ entries }) => {
      if (!entries.length) {
        tbody.appendChild(h("tr", {}, h("td", { colspan: "5", class: "muted" }, "No changes recorded yet.")));
        return;
      }
      entries.forEach((entry) => {
        const tr = h("tr");
        tr.appendChild(h("td", {}, new Date(entry.timestamp).toLocaleString()));
        tr.appendChild(h("td", {}, entry.actor));
        tr.appendChild(h("td", {}, entry.action));
        tr.appendChild(h("td", {}, `${entry.targetItemType || "?"} ${entry.targetKey?.PK || ""} / ${entry.targetKey?.SK || ""}`));
        const tdChanges = h("td");
        entry.changes.forEach((c) => {
          tdChanges.appendChild(h("div", {}, `${c.field}: ${fmtAuditValue(c.before)} → ${fmtAuditValue(c.after)}`));
        });
        tr.appendChild(tdChanges);
        tbody.appendChild(tr);
      });
    })
    .catch((err) => {
      tbody.appendChild(h("tr", {}, h("td", { colspan: "5", class: "muted" }, `Could not load audit log: ${err.message}`)));
    });
}

// ---------- My Account (profile) ----------
// Every logged-in user gets this tab — no permission gate beyond being
// authenticated, since it only ever acts on the caller's own account.
function renderProfile(container) {
  const myDriver = CURRENT_USER.driverId ? DATA.drivers.find((d) => d.driverId === CURRENT_USER.driverId) : null;

  const panel = h("div", { class: "panel" });
  panel.appendChild(h("h2", {}, "Account"));
  const kv = h("div", { class: "kv-grid" });
  kv.appendChild(h("label", {}, "Role"));
  kv.appendChild(h("div", {}, CURRENT_USER.role));
  if (CURRENT_USER.driverId) {
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

  // Opt-in cosmetic feature — only makes sense for a logged-in user who's
  // actually linked to a driver record (see driverIndicator/numberBadge).
  // Placed right below Username since it's the other thing most drivers
  // will actually come to this page to change.
  if (myDriver) {
    const panel2b = h("div", { class: "panel" });
    panel2b.appendChild(h("h2", {}, "Driver Number Badge"));
    panel2b.appendChild(h("p", { class: "muted panel-note" },
      "Set a number to replace your color dot everywhere with a custom badge. Leave it blank to keep the plain color dot."
    ));

    const previewWrap = h("div", { style: "display:flex; align-items:center; gap:10px; margin-bottom:14px;" });
    let preview = driverIndicator(myDriver);
    previewWrap.appendChild(preview);
    previewWrap.appendChild(h("span", { class: "muted" }, myDriver.driver));
    panel2b.appendChild(previewWrap);

    const refreshPreview = () => {
      const next = driverIndicator(myDriver);
      previewWrap.replaceChild(next, preview);
      preview = next;
    };

    // driverNumber needs its own direct save (not the debounced
    // saveDriverFields path below) since a 409 conflict needs custom
    // handling — same shape as the Drivers tab's car-color picker. Font/
    // style still save the moment they change (via saveDriverFields), but
    // the button — the one action that can fail and needs a result to
    // read — sits below all three fields, not sandwiched between them.
    const numberInput = h("input", { type: "text", maxlength: "2" });
    numberInput.value = myDriver.driverNumber || "";
    panel2b.appendChild(labeledField("Driver number (1-2 digits, leave blank for none)", numberInput));

    const fontSelect = selectInput(myDriver.numberFont || NUMBER_BADGE_FONTS[0].id,
      NUMBER_BADGE_FONTS.map((f) => ({ value: f.id, label: f.label })),
      (v) => { myDriver.numberFont = v; refreshPreview(); saveDriverFields(myDriver.driverId, { numberFont: v }); });
    panel2b.appendChild(labeledField("Font", fontSelect));

    const shapeSelect = selectInput(resolveBgShape(myDriver.numberBgShape),
      NUMBER_BG_SHAPES.map((s) => ({ value: s.id, label: s.label })),
      (v) => { myDriver.numberBgShape = v; refreshPreview(); saveDriverFields(myDriver.driverId, { numberBgShape: v }); });
    panel2b.appendChild(labeledField("Background", shapeSelect));

    // "White" keeps the number itself as the bold car color (the default);
    // "Team color" inverts it — background becomes the car color, number
    // becomes white — see numberBadge().
    const bgColorSelect = selectInput(myDriver.numberBgColor || NUMBER_BG_COLORS[0].id,
      NUMBER_BG_COLORS.map((c) => ({ value: c.id, label: c.label })),
      (v) => { myDriver.numberBgColor = v; refreshPreview(); saveDriverFields(myDriver.driverId, { numberBgColor: v }); });
    panel2b.appendChild(labeledField("Background color", bgColorSelect));

    const numberMsgEl = h("div", { class: "auth-error" });
    const numberBtn = h("button", { class: "btn primary" }, "Save number");
    numberBtn.addEventListener("click", async () => {
      numberMsgEl.style.color = "";
      numberMsgEl.textContent = "";
      const v = numberInput.value.trim();
      numberBtn.disabled = true;
      try {
        const body = await apiPut(`/api/drivers/${myDriver.driverId}/driver-number`, { driverNumber: v });
        myDriver.driverNumber = body.driverNumber;
        myDriver.numberConflict = null;
        numberInput.value = myDriver.driverNumber || "";
        refreshPreview();
        numberMsgEl.style.color = "var(--good)";
        numberMsgEl.textContent = v ? "Number saved." : "Cleared — showing your color dot again.";
      } catch (err) {
        numberInput.value = myDriver.driverNumber || "";
        const holder = err.status === 409
          ? DATA.drivers.find((x) => x !== myDriver && x.driverNumber === v)?.driver
          : null;
        myDriver.numberConflict = { attempted: v, holder, message: err.message };
        numberMsgEl.textContent = err.message;
      }
      numberBtn.disabled = false;
    });
    panel2b.appendChild(numberBtn);
    panel2b.appendChild(numberMsgEl);
    if (myDriver.numberConflict) {
      panel2b.appendChild(
        h("div", { class: "color-conflict-note" },
          h("span", { class: "compliance-icon" }, "!"),
          ` Tried to set your number to "${myDriver.numberConflict.attempted}"${myDriver.numberConflict.holder ? `, but it's already used by ${myDriver.numberConflict.holder}` : ""} — try a different number.`
        )
      );
    }

    container.appendChild(panel2b);
  }

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

  const panel4 = h("div", { class: "panel" });
  panel4.appendChild(h("h2", {}, "Home Page"));
  panel4.appendChild(h("p", { class: "muted panel-note" }, `Pick up to ${MAX_HOME_CARDS} pages to feature on your Home tab.`));
  const selected = new Set(currentHomeCardIds());
  const checkboxes = [];
  const updateDisabledState = () => {
    const atMax = selected.size >= MAX_HOME_CARDS;
    checkboxes.forEach(([id, cb]) => { if (!cb.checked) cb.disabled = atMax; });
  };
  const list = h("div", { style: "display:flex; flex-direction:column; gap:8px; margin-bottom:14px;" });
  HOME_PAGE_CATALOG.forEach((c) => {
    const row = h("label", { style: "display:flex; align-items:center; gap:8px; cursor:pointer;" });
    const cb = h("input", { type: "checkbox" });
    cb.style.width = "auto";
    cb.checked = selected.has(c.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(c.id); else selected.delete(c.id);
      updateDisabledState();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(c.title));
    checkboxes.push([c.id, cb]);
    list.appendChild(row);
  });
  updateDisabledState();
  panel4.appendChild(list);

  const homeCardsMsgEl = h("div", { class: "auth-error" });
  const homeCardsBtn = h("button", { class: "btn primary" }, "Save Home page picks");
  homeCardsBtn.addEventListener("click", async () => {
    homeCardsMsgEl.style.color = "";
    homeCardsMsgEl.textContent = "";
    if (selected.size === 0) { homeCardsMsgEl.textContent = "Pick at least one page."; return; }
    homeCardsBtn.disabled = true;
    try {
      const cards = HOME_PAGE_CATALOG.filter((c) => selected.has(c.id)).map((c) => c.id);
      const body = await apiPut("/api/auth/home-cards", { cards });
      CURRENT_USER.homeCards = body.homeCards;
      homeCardsMsgEl.style.color = "var(--good)";
      homeCardsMsgEl.textContent = "Saved — check the Home tab.";
    } catch (err) {
      homeCardsMsgEl.textContent = err.message;
    }
    homeCardsBtn.disabled = false;
  });
  panel4.appendChild(homeCardsMsgEl);
  panel4.appendChild(homeCardsBtn);
  container.appendChild(panel4);
}

// ---------- tabs infra ----------
function buildStandingsSummary() {
  recomputeStandings();
  const wrap = h("div", { class: "table-scroll" });
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Pts"), h("th", {}, "Pos"))));
  const tbody = h("tbody");
  const sorted = [...DATA.standings.drivers].sort((a, b) => a.position - b.position);
  for (const d of sorted) {
    tbody.appendChild(
      h("tr", {}, h("td", {}, driverBadge(d.driver)), h("td", {}, String(d.totalPoints)), h("td", { class: podiumClass("pos-", d.position) }, String(d.position)))
    );
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildRaceResultsSummary() {
  recomputeStandings();
  const wrap = h("div", { class: "race-results-summary" });
  DATA.standings.raceLabels.forEach((label, i) => {
    wrap.appendChild(buildRaceResultBlock(label || `Race ${i + 1}`, i));
  });
  return wrap;
}

function buildDriversSummary() {
  // A CSS class, not an inline style: the mobile bento layout hides a
  // collapsed card's content with `.bento-card > *:not(h3) { display:
  // none }`, and an inline style on this element would out-specificity
  // that rule regardless of what the stylesheet says.
  const list = h("div", { class: "bento-driver-list" });
  DATA.drivers.forEach((d) => {
    const row = h("div", { style: "display:flex; align-items:center; justify-content:space-between; gap:10px;" });
    row.appendChild(driverBadge(d.driver));
    row.appendChild(h("span", { class: "muted" }, d.teamName || ""));
    list.appendChild(row);
  });
  return list;
}

function buildUpgradesSummary() {
  const wrap = h("div", { class: "table-scroll" });
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Upgrades"), h("th", {}, "Remaining"))));
  const tbody = h("tbody");
  for (const e of DATA.upgradeTracker.entries) {
    const picked = e.upgrades.filter((p) => p != null);
    const upgradesCell = h("div", { class: "upgrade-mini-list" });
    picked.forEach((partNumber) => {
      const u = DATA.inventory.upgrades.find((u) => u.partNumber === Number(partNumber));
      const badge = h("span", { class: "badge" }, `#${partNumber}${u ? " · " + u.type : ""}`);
      attachZoomCard(badge, partCardImagePath(partNumber), `Part #${partNumber} card`);
      upgradesCell.appendChild(badge);
    });
    tbody.appendChild(h("tr", {}, h("td", {}, driverBadge(e.driver)), h("td", {}, upgradesCell), h("td", {}, fmtMoney(e.remainingBudget))));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildSeasonSummary() {
  const s = DATA.season;
  const wrap = h("div", {});
  const stats = h("div", { style: "display:flex; gap:18px; flex-wrap:wrap; margin-bottom:14px;" });
  const stat = (label, value) => h("div", {}, h("div", { class: "muted", style: "font-size:0.78rem;" }, label), h("div", { style: "font-weight:700; font-size:1.1rem;" }, String(value ?? "—")));
  stats.appendChild(stat("Season", s.label));
  stats.appendChild(stat("Races", s.racesThisSeason));
  stats.appendChild(stat("Upgrade slots", s.upgradeSlots));
  wrap.appendChild(stats);

  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Race #"), h("th", {}, "Track"))));
  const tbody = h("tbody");
  (s.schedule || []).forEach((r) => tbody.appendChild(h("tr", {}, h("td", {}, String(r.race)), h("td", {}, r.track))));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildInventorySummary() {
  const wrap = h("div", {});
  wrap.appendChild(h("p", { class: "muted", style: "margin:0 0 10px; font-size:0.85rem;" }, `${DATA.inventory.upgrades.length} upgrade parts available`));
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Sponsor"), h("th", {}, "Funding"))));
  const tbody = h("tbody");
  for (const s of DATA.inventory.sponsors) tbody.appendChild(h("tr", {}, h("td", {}, s.name), h("td", {}, fmtMoney(s.funding))));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildTechRegsSummary() {
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Regulation"))));
  const tbody = h("tbody");
  for (const r of DATA.technicalRegulations) tbody.appendChild(h("tr", {}, h("td", {}, r.name)));
  table.appendChild(tbody);
  return table;
}

function buildFiccSummary() {
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Driver"), h("th", {}, "Proposed Regulation"))));
  const tbody = h("tbody");
  for (const p of DATA.ficcBacklog.proposals) {
    if (!p.regulationName) continue;
    tbody.appendChild(h("tr", {}, h("td", {}, p.driverName || "Freeform"), h("td", {}, p.regulationName)));
  }
  table.appendChild(tbody);
  return table;
}

function buildOffSeasonSummary() {
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Tier"), h("th", {}, "Upgrade Exchange"))));
  const tbody = h("tbody");
  for (const r of DATA.offSeasonBudget.regulations) tbody.appendChild(h("tr", {}, h("td", {}, r.tier), h("td", {}, r.upgradeExchange)));
  table.appendChild(tbody);
  return table;
}

function buildHofSummary() {
  const table = h("table");
  table.appendChild(h("thead", {}, h("tr", {}, h("th", {}, "Season"), h("th", {}, "Champion"))));
  const tbody = h("tbody");
  for (const row of DATA.hallOfFame.seasonLog) tbody.appendChild(h("tr", {}, h("td", { class: "cell-computed" }, String(row.season)), h("td", {}, row.champion || "")));
  table.appendChild(tbody);
  return table;
}

function buildLoreSummary() {
  const l = DATA.lore;
  const wrap = h("div", {});
  const kv = h("div", { class: "kv-grid" });
  const addKV = (label, value) => { kv.appendChild(h("label", {}, label)); kv.appendChild(h("div", {}, value || "—")); };
  addKV("League", l.leagueName);
  addKV("Governing body", l.governingBody);
  addKV("Motto", l.motto);
  addKV("Driver's Trophy", l.driversTrophy?.name);
  wrap.appendChild(kv);
  return wrap;
}

// ---------- Home (bento-style overview) ----------
// Read-only summaries only — each card links out to its real tab for
// editing, rather than duplicating every tab's full editable content here.
// Kept in sync with HOME_CARD_IDS in server/routes/auth.routes.js.
const HOME_PAGE_CATALOG = [
  { id: "standings", title: "Standings", build: buildStandingsSummary },
  { id: "race-results", title: "Race Results", build: buildRaceResultsSummary },
  { id: "drivers", title: "Drivers", build: buildDriversSummary },
  { id: "upgrades", title: "Upgrade Tracker", build: buildUpgradesSummary },
  { id: "inventory", title: "Inventory", build: buildInventorySummary },
  { id: "season", title: "Season & Schedule", build: buildSeasonSummary },
  { id: "techregs", title: "Technical Regs", build: buildTechRegsSummary },
  { id: "ficc", title: "FICC Backlog", build: buildFiccSummary },
  { id: "offseason", title: "Off-Season Budget", build: buildOffSeasonSummary },
  { id: "hof", title: "Hall of Fame", build: buildHofSummary },
  { id: "lore", title: "Lore & Trophies", build: buildLoreSummary },
];
const DEFAULT_HOME_CARDS = ["standings", "drivers", "upgrades", "season"];
const MAX_HOME_CARDS = 6;

function currentHomeCardIds() {
  const known = new Set(HOME_PAGE_CATALOG.map((c) => c.id));
  const chosen = (CURRENT_USER?.homeCards || DEFAULT_HOME_CARDS).filter((id) => known.has(id));
  return (chosen.length ? chosen : DEFAULT_HOME_CARDS).slice(0, MAX_HOME_CARDS);
}

// FLIP animation (First-Last-Invert-Play): captures each card's on-screen
// rect before the layout change, applies the change, then plays an inverse
// transform back to identity. This is what makes the reflow (the expanded
// card swapping, every other card sliding to a new spot — including
// moving to a different parent element) animate smoothly — a plain CSS
// transition can't animate flex-basis/reparenting, since the browser
// treats those as discrete layout jumps rather than continuously
// interpolable values. getBoundingClientRect() is viewport-relative, so
// this works fine even when a card moves to a different parent container.
function animateBentoReflow(cardEls, applyChange) {
  const before = cardEls.map((el) => [el, el.getBoundingClientRect()]);
  applyChange();
  for (const [el, from] of before) {
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    if (!dx && !dy && sx === 1 && sy === 1) continue;
    el.style.transition = "none";
    el.style.transformOrigin = "top left";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth; // force layout so the transform above actually applies before we transition away from it
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.45s ease";
      el.style.transform = "";
    });
  }
}

// Every card renders its full content immediately and stays mounted for
// the lifetime of this render. Layout is two containers: one holds the
// single expanded card, the other holds every other card stacked in a
// column with equal flex-basis — so the collapsed cards always
// collectively fill exactly the expanded card's height, whether there's
// one of them or five, with no leftover gap. Expand/collapse moves a card
// between the two containers rather than re-rendering, which is what lets
// animateBentoReflow find the persistent elements and interpolate them.
// Copies the expanded card's resolved (content-driven) height onto the
// collapsed column, so the collapsed cards collectively fill exactly that
// height (dividing it via their own flex:1) instead of the column's full
// unconstrained content sum inflating the expanded side — see the comment
// on .bento-grid in style.css for why plain align-items: stretch can't do
// this on its own. Skipped on the mobile layout, where the grid stacks to
// a single column and each side sizes independently.
function syncBentoHeights(grid, expandedWrap, collapsedWrap) {
  const isRow = getComputedStyle(grid).flexDirection === "row";
  collapsedWrap.style.height = isRow ? `${expandedWrap.offsetHeight}px` : "";
}

function renderHome(container) {
  const grid = h("div", { class: "bento-grid" });
  const expandedWrap = h("div", { class: "bento-expanded-wrap" });
  const collapsedWrap = h("div", { class: "bento-collapsed-wrap" });
  grid.appendChild(expandedWrap);
  grid.appendChild(collapsedWrap);

  const cardIds = currentHomeCardIds();
  if (!cardIds.includes(homeExpandedCard)) homeExpandedCard = cardIds[0];
  const cardEls = [];

  function placeCards() {
    cardEls.forEach(([id, el]) => {
      const isExpanded = id === homeExpandedCard;
      el.classList.toggle("expanded", isExpanded);
      (isExpanded ? expandedWrap : collapsedWrap).appendChild(el);
    });
    syncBentoHeights(grid, expandedWrap, collapsedWrap);
  }

  cardIds.forEach((id) => {
    const c = HOME_PAGE_CATALOG.find((page) => page.id === id);
    const card = h("div", { class: "bento-card" });
    card.appendChild(h("h3", {}, c.title));
    card.appendChild(c.build());
    const linkBtn = h("button", { class: "btn primary bento-view-full" }, `View full ${c.title} tab →`);
    linkBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToTab(c.id);
    });
    card.appendChild(linkBtn);

    card.addEventListener("click", () => {
      if (id === homeExpandedCard) return;
      homeExpandedCard = id;
      animateBentoReflow(cardEls.map(([, el]) => el), placeCards);
    });

    cardEls.push([id, card]);
  });

  // grid must be attached to the document before placeCards() runs — it
  // calls syncBentoHeights(), which measures expandedWrap.offsetHeight;
  // measuring a detached element always reads 0, which is why this bug
  // only showed up on first load (later calls happen after the grid is
  // already live, from a card's click handler).
  container.appendChild(grid);
  placeCards();
}

const TABS = [
  { id: "home", label: "Home", render: renderHome },
  { id: "standings", label: "Standings", render: renderStandings },
  { id: "race-results", label: "Race Results", render: renderRaceResults },
  { id: "drivers", label: "Drivers", render: renderDrivers },
  { id: "upgrades", label: "Upgrade Tracker", render: renderUpgradeTracker },
  { id: "inventory", label: "Inventory", render: renderInventory },
  { id: "season", label: "Season & Schedule", render: renderSeason },
  { id: "techregs", label: "Technical Regs", render: renderTechRegs },
  { id: "ficc", label: "FICC Backlog", render: renderFiccBacklog },
  { id: "offseason", label: "Off-Season Budget", render: renderOffSeason },
  { id: "hof", label: "Hall of Fame", render: renderHallOfFame },
  { id: "lore", label: "Lore & Trophies", render: renderLore },
  { id: "auditlog", label: "Audit Log", render: renderAuditLog, adminOnly: true },
  { id: "profile", label: "My Account", render: renderProfile },
];

function goToTab(tabId) {
  activeTab = tabId;
  renderTabs();
  renderActive();
  closeMobileNav();
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  // "My Account" needs a real logged-in account — anonymous visitors never
  // see it (and can't land on it: its id can't come from anywhere else).
  // adminOnly tabs (e.g. Audit Log) are hidden from everyone else too.
  const visibleTabs = TABS.filter((t) => (t.id !== "profile" || CURRENT_USER) && (!t.adminOnly || isAdmin()));
  if (!CURRENT_USER && activeTab === "profile") activeTab = "home";
  if (!isAdmin() && TABS.find((t) => t.id === activeTab)?.adminOnly) activeTab = "home";
  for (const t of visibleTabs) {
    const btn = h("button", { class: "tab-btn" + (t.id === activeTab ? " active" : "") }, t.label);
    btn.addEventListener("click", () => goToTab(t.id));
    nav.appendChild(btn);
  }
}

// ---------- Mobile nav (hamburger sidebar) ----------
// The topbar's height isn't fixed (it wraps to two rows on narrow phones),
// so the sidebar's top offset is read from the real DOM rather than
// guessed at in CSS — recomputed on load and on resize/orientation change.
function syncTopbarHeight() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
}
window.addEventListener("resize", syncTopbarHeight);
window.addEventListener("resize", () => {
  const grid = document.querySelector(".bento-grid");
  const expandedWrap = document.querySelector(".bento-expanded-wrap");
  const collapsedWrap = document.querySelector(".bento-collapsed-wrap");
  if (grid && expandedWrap && collapsedWrap) syncBentoHeights(grid, expandedWrap, collapsedWrap);
});
document.querySelector(".brand .logo img")?.addEventListener("load", syncTopbarHeight);

function closeMobileNav() {
  document.getElementById("tabs").classList.remove("open");
  document.getElementById("nav-backdrop").classList.remove("open");
  document.getElementById("hamburger-btn").setAttribute("aria-expanded", "false");
}

function toggleMobileNav() {
  const isOpen = document.getElementById("tabs").classList.toggle("open");
  document.getElementById("nav-backdrop").classList.toggle("open", isOpen);
  document.getElementById("hamburger-btn").setAttribute("aria-expanded", String(isOpen));
}

function renderActive() {
  // attachZoomCard (see above) appends each card's zoom popup to <body>
  // directly rather than under #tab-content, so clearing #tab-content
  // below doesn't clean these up on its own — without this they'd pile
  // up as orphans, one extra per card, on every re-render.
  document.querySelectorAll(".upgrade-card-zoom-wrap").forEach((el) => el.remove());
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
      if (body.mustChangePassword) {
        CURRENT_USER = body;
        showAuthScreen(renderChangePasswordForm());
      } else {
        // Reload rather than calling loadAppData() directly: this app can
        // now show the anonymous read-only view before any login, which
        // already ran loadAppData() once — calling it again here would
        // double up every event listener it wires (logout button, hamburger
        // nav, etc.). A reload keeps "loadAppData runs once per page load"
        // true regardless of which path got there.
        window.location.reload();
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
      // See the matching comment in renderLoginForm — reload instead of
      // calling loadAppData() directly, so it can't run twice in one page
      // lifetime now that an anonymous view can precede login.
      window.location.reload();
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

  const authBtn = document.getElementById("logout-btn");
  if (CURRENT_USER) {
    document.getElementById("whoami").textContent = `${CURRENT_USER.username} (${CURRENT_USER.role})`;
    authBtn.textContent = "Log out";
    authBtn.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.reload();
    });
  } else {
    // Nothing is editable without an account (isAdmin()/isSelfOrAdmin()
    // are both false for a null CURRENT_USER), so there's nothing to
    // save — hide the save controls rather than show a button that would
    // always be a no-op.
    document.getElementById("whoami").textContent = "Viewing as guest";
    document.getElementById("save-now-btn").style.display = "none";
    document.getElementById("save-state").style.display = "none";
    authBtn.textContent = "Log in";
    authBtn.addEventListener("click", () => showAuthScreen(renderLoginForm()));
  }

  setSaveState("saved");
  document.getElementById("save-now-btn").addEventListener("click", () => flushAllSaves());
  document.getElementById("hamburger-btn").addEventListener("click", toggleMobileNav);
  document.getElementById("nav-backdrop").addEventListener("click", closeMobileNav);
  document.querySelector(".brand").addEventListener("click", () => goToTab("home"));
  renderTabs();
  syncTopbarHeight();
}

async function init() {
  const res = await fetch("/api/auth/me");
  if (res.ok) {
    CURRENT_USER = await res.json();
    if (CURRENT_USER.mustChangePassword) {
      showAuthScreen(renderChangePasswordForm());
      return;
    }
  } else {
    // Not logged in isn't a wall anymore — GET /api/data is public, so the
    // app shell renders read-only for anonymous visitors (isAdmin() and
    // isSelfOrAdmin() both already treat a null CURRENT_USER as "no
    // permissions", which is what makes every edit control across the app
    // fall back to its read-only rendering automatically). Logging in is
    // still available via the topbar's Log in button — see loadAppData().
    CURRENT_USER = null;
  }
  showApp();
  await loadAppData();
}

init();
