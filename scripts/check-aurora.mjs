// Nightly aurora-likelihood check for GitHub Actions.
//
// Reuses the dashboard's own browser scripts (js/data.js, js/api.js, js/score.js) by
// evaluating them in a Node vm context, so the alert logic can never drift from what
// the dashboard shows. Emits GitHub Actions outputs: alert, date, title, body.
//
// Alert policy (Joan's rule): email when an upcoming night is forecast to reach
// Kp >= 7 — the "worth the drive" naked-eye threshold — anchored on her default
// location, Werribee South. An active BOM SWS Aurora Alert also emails immediately.

import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SunCalc = require("suncalc");

const vmGlobals = vm.createContext({
  fetch: (...args) => globalThis.fetch(...args),
  setTimeout,
  console,
  SunCalc
});
// Concatenate the browser scripts and return the bindings we need — top-level
// const/function declarations in a vm script are lexical, not context globals.
const source = ["js/data.js", "js/api.js", "js/score.js"]
  .map(f => fs.readFileSync(f, "utf8"))
  .join("\n;\n");
const ctx = vm.runInContext(
  source + `\n;({ LOCATIONS, kpBand, fetchThreeDayForecast, fetchTwentySevenDayOutlook,
    fetchNightlyCloudCover, darknessWindowFor, buildNightlyOutlook })`,
  vmGlobals,
  { filename: "dashboard-bundle.js" }
);

// The drive threshold and home location. Both overridable from the workflow.
const MIN_KP = parseInt(process.env.ALERT_MIN_KP || "7", 10);
const HOME_ID = process.env.ALERT_LOCATION || "werribee-south";

// BOM SWS snapshot, produced by scripts/fetch-sws.mjs in a prior workflow step.
// Optional: everything degrades to NOAA-only behaviour without it.
let sws = null;
try {
  const parsed = JSON.parse(fs.readFileSync("sws.json", "utf8"));
  if (parsed.available) sws = parsed;
} catch {
  console.error("No sws.json — running NOAA-only.");
}

function melbourneToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function fmtDate(dateStr) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-AU", {
    weekday: "short", day: "numeric", month: "short"
  });
}

function fmtTime(date) {
  if (!date || isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-AU", {
    hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne"
  });
}

const today = melbourneToday();
const home = ctx.LOCATIONS.find(l => l.id === HOME_ID) || ctx.LOCATIONS[0];

const [threeDay, outlook27] = await Promise.all([
  ctx.fetchThreeDayForecast(),
  ctx.fetchTwentySevenDayOutlook()
]);

// Build a per-night outlook for every location (needed for the "darker alternative" note);
// the home location's outlook drives the trigger.
const outlooks = new Map();
for (const loc of ctx.LOCATIONS) {
  const cloudMap = await ctx.fetchNightlyCloudCover(loc.lat, loc.lon, 16);
  outlooks.set(loc.id, ctx.buildNightlyOutlook({ threeDay, outlook27, cloudMap, location: loc, today }));
}
const homeOutlook = outlooks.get(home.id);
if (!homeOutlook || !homeOutlook.length) {
  console.error("No outlook for home location — data sources may be down.");
  process.exit(1);
}

// Drive-worthy nights: forecast Kp at/above the threshold. Pick the strongest show
// (highest Kp, then best viewing score, then soonest).
const qualifying = homeOutlook
  .filter(n => n.kp >= MIN_KP)
  .sort((a, b) => b.kp - a.kp || b.score - a.score || a.date.localeCompare(b.date));
const driveNight = qualifying[0] || null;

const bestHomeNight = [...homeOutlook].sort((a, b) => b.score - a.score)[0];
const swsAlertActive = Boolean(sws?.alert);
const swsWatchActive = Boolean(sws?.watch);
const alert = Boolean(driveNight) || swsAlertActive || swsWatchActive;

// Primary framing, most urgent first: a happening-now BOM Alert, then a Kp>=7 drive
// night, then a BOM Watch heads-up. Any lower-priority signal still appears in the
// body's BOM section, so one email covers everything active.
const mode = swsAlertActive ? "sws-alert"
  : driveNight ? "drive"
  : swsWatchActive ? "watch"
  : null;

console.log(`Home: ${home.name}. Drive threshold: Kp >= ${MIN_KP}. Mode: ${mode || "no alert"}.`);
console.log(driveNight
  ? `Drive-worthy night: ${driveNight.date} — Kp ${driveNight.kp} (${driveNight.kpPrecision}), score ${driveNight.score}/100.`
  : `No upcoming night reaches Kp ${MIN_KP} at ${home.name} (best is Kp ${bestHomeNight.kp} on ${bestHomeNight.date}).`);
if (swsAlertActive) console.log("BOM SWS Aurora Alert is ACTIVE now — will email regardless of Kp.");
if (swsWatchActive) console.log(`BOM SWS Aurora Watch active (${sws.watch.start_date} – ${sws.watch.end_date}) — will email a heads-up.`);

// The night the email is anchored on, and the per-event dedupe key (must appear in the title).
const eventNight = mode === "drive"
  ? driveNight
  : mode === "watch"
    ? (homeOutlook.find(n => n.date === sws.watch.start_date) || bestHomeNight)
    : (homeOutlook.find(n => n.date === today) || bestHomeNight);
const alertDate = mode === "drive"
  ? driveNight.date
  : mode === "watch"
    ? "watch-" + sws.watch.start_date
    : today;

// Darkest-sky alternative for that same night (higher-scoring spot than home, if any).
let alt = null;
for (const loc of ctx.LOCATIONS) {
  if (loc.id === home.id) continue;
  const n = outlooks.get(loc.id).find(x => x.date === eventNight.date);
  if (n && (!alt || n.score > alt.night.score)) alt = { loc, night: n };
}

function swsSection() {
  if (!sws) return "";
  const lines = [];
  if (sws.alert) {
    lines.push(`> **⚠ AURORA ALERT (active now):** ${sws.alert.description || "Aurora conditions are occurring."} Latitude band: ${sws.alert.lat_band || "?"}, K-aus ${sws.alert.k_aus ?? "?"}. Valid until ${sws.alert.valid_until} AEST.`);
  }
  if (sws.watch) {
    lines.push(`> **Aurora Watch:** ${sws.watch.start_date} to ${sws.watch.end_date} (cause: ${sws.watch.cause || "unspecified"}, expected K-aus ${sws.watch.k_aus ?? "?"}). ${sws.watch.comments || ""}`.trim());
  }
  if (sws.outlook) {
    lines.push(`> **Aurora Outlook:** ${sws.outlook.start_date} to ${sws.outlook.end_date} (cause: ${sws.outlook.cause || "unspecified"}). ${sws.outlook.comments || ""}`.trim());
  }
  if (sws.k_aus) {
    lines.push(`> Current Australian-region K index: **${sws.k_aus.index}** (3-hr block from ${sws.k_aus.valid_time} AEST).`);
  }
  if (!lines.length) return "";
  return `\n**BOM Space Weather Service (Australian region)**\n\n${lines.join("\n>\n")}\n`;
}

let title = "";
let body = "";

if (alert) {
  const darkness = ctx.darknessWindowFor(new Date(eventNight.date + "T12:00:00"), home.lat, home.lon);
  const cloudStr = eventNight.cloudPct == null ? "no forecast yet" : Math.round(eventNight.cloudPct) + "%";

  let lead;
  if (mode === "sws-alert") {
    title = `Aurora alert: BOM SWS alert ACTIVE now (${today})`;
    lead = `BOM's Space Weather Service has an **active Aurora Alert right now** — aurora may be visible from southern Victoria tonight.`;
  } else if (mode === "drive") {
    title = `Aurora: Kp ${driveNight.kp} forecast ${fmtDate(driveNight.date)} — worth the drive (${driveNight.date})`;
    lead = `Forecast conditions reach **Kp ${driveNight.kp}** — at or above your Kp ${MIN_KP} drive threshold.`;
  } else { // watch
    title = `Aurora Watch (BOM): ${sws.watch.start_date} to ${sws.watch.end_date} (watch-${sws.watch.start_date})`;
    lead = `BOM's Space Weather Service has issued an **Aurora Watch** for ${sws.watch.start_date} to ${sws.watch.end_date}${sws.watch.cause ? ` (${sws.watch.cause})` : ""} — a heads-up that conditions may become favourable. Keep an eye on the Kp forecast; nothing has yet reached your Kp ${MIN_KP} drive threshold.`;
  }

  const altLine = alt
    ? `\n**Darker-sky option that night:** ${alt.loc.name} scores ${alt.night.score}/100 (vs ${eventNight.score} at ${home.name})${alt.night.cloudPct == null ? "" : `, ${Math.round(alt.night.cloudPct)}% cloud`}. Worth the extra drive if you want the best show.\n`
    : "";

  body = `**Aurora Australis Watch — Victoria**

${lead}

| | |
|---|---|
| Night | ${fmtDate(eventNight.date)} |
| Forecast Kp index | **${eventNight.kp}** (${eventNight.kpPrecision}) — ${ctx.kpBand(eventNight.kp).label} |
| Your spot | ${home.name} |
| Viewing score there | ${eventNight.score}/100 (${eventNight.verdict.label}) |
| Cloud cover | ${cloudStr} |
| Moon | ${eventNight.moon.phaseName} (${Math.round(eventNight.moon.fraction * 100)}% illuminated) |
| Dark viewing window | ${fmtTime(darkness.start)} – ${fmtTime(darkness.end)} (nautical dusk–dawn, Melbourne time) |
${altLine}${swsSection()}
Face south toward an open, unobstructed horizon. Give your eyes 15–20 minutes to adjust to the dark, and check for a faint glow or coloured pillars low on the southern horizon — cameras (even phone night mode) often pick up colour the naked eye can't.

[Open the live dashboard](https://varionsystemslab.github.io/aurora-australis-watch/)

_Automated alert from the daily aurora-alert workflow. Triggers: forecast Kp ≥ ${MIN_KP} at ${home.name}, an active BOM Aurora Alert, or an active BOM Aurora Watch._`;
}

if (process.env.GITHUB_OUTPUT) {
  const out = [
    `alert=${alert}`,
    `date=${alertDate}`,
    `title=${title}`,
    "body<<AURORA_BODY_EOF",
    body,
    "AURORA_BODY_EOF"
  ].join("\n") + "\n";
  fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
}
