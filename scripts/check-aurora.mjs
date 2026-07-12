// Nightly aurora-likelihood check for GitHub Actions.
//
// Reuses the dashboard's own browser scripts (js/data.js, js/api.js, js/score.js) by
// evaluating them in a Node vm context, so the alert logic can never drift from what
// the dashboard shows. Emits GitHub Actions outputs: alert, date, title, body.

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

const BASE_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || "55", 10);
// When BOM SWS has an active Aurora Watch, drop the bar: their forecasters
// expect activity, so a moderate composite score is worth an email.
const WATCH_THRESHOLD = 40;

// BOM SWS snapshot, produced by scripts/fetch-sws.mjs in a prior workflow step.
// Optional: everything degrades to NOAA-only behaviour without it.
let sws = null;
try {
  const parsed = JSON.parse(fs.readFileSync("sws.json", "utf8"));
  if (parsed.available) sws = parsed;
} catch {
  console.error("No sws.json — running NOAA-only.");
}

const THRESHOLD = sws?.watch ? Math.min(BASE_THRESHOLD, WATCH_THRESHOLD) : BASE_THRESHOLD;

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
const [threeDay, outlook27] = await Promise.all([
  ctx.fetchThreeDayForecast(),
  ctx.fetchTwentySevenDayOutlook()
]);

// Best night = highest score among nights that have a real cloud forecast (~16 days out),
// matching the dashboard's bestNightAcrossLocations().
let best = null;
for (const loc of ctx.LOCATIONS) {
  const cloudMap = await ctx.fetchNightlyCloudCover(loc.lat, loc.lon, 16);
  const outlook = ctx.buildNightlyOutlook({ threeDay, outlook27, cloudMap, location: loc, today });
  for (const night of outlook) {
    if (night.cloudPct == null) continue;
    if (!best || night.score > best.score) best = { ...night, loc };
  }
}

if (!best) {
  console.error("No scored nights with cloud data — data sources may be down.");
  process.exit(1);
}

console.log(`Best night: ${best.date} at ${best.loc.name} — score ${best.score}/100 (threshold ${THRESHOLD})`);
if (sws?.watch) console.log(`SWS Aurora Watch active (${sws.watch.start_date} – ${sws.watch.end_date}) — threshold lowered to ${THRESHOLD}.`);

// A live SWS Aurora Alert means BOM forecasters say conditions are favourable
// RIGHT NOW — email immediately, whatever the composite score says.
const swsAlertActive = Boolean(sws?.alert);
const alert = swsAlertActive || best.score >= THRESHOLD;
let title = "";
let body = "";

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

// The dedupe key: SWS-driven alerts key on today (the event is NOW), score-driven
// alerts key on the best night.
const alertDate = swsAlertActive ? today : best.date;

if (alert) {
  const darkness = ctx.darknessWindowFor(new Date(best.date + "T12:00:00"), best.loc.lat, best.loc.lon);
  title = swsAlertActive
    ? `Aurora alert: BOM SWS alert ACTIVE now (${alertDate})`
    : `Aurora alert: ${best.verdict.label} chance on ${fmtDate(best.date)} (${best.date})`;
  body = `**Aurora Australis Watch — Victoria**

| | |
|---|---|
| Most likely night | ${fmtDate(best.date)} |
| Likelihood score | **${best.score}/100 (${best.verdict.label})** |
| Best location | ${best.loc.name} |
| Forecast Kp index | ${best.kp} (${best.kpPrecision}) — ${ctx.kpBand(best.kp).label} |
| Cloud cover | ${Math.round(best.cloudPct)}% |
| Moon | ${best.moon.phaseName} (${Math.round(best.moon.fraction * 100)}% illuminated) |
| Dark viewing window | ${fmtTime(darkness.start)} – ${fmtTime(darkness.end)} (nautical dusk–dawn, Melbourne time) |

${swsSection()}
Face south toward an open, unobstructed horizon. Give your eyes 15–20 minutes to adjust to the dark, and check for a faint glow or coloured pillars low on the southern horizon — cameras (even phone night mode) often pick up colour the naked eye can't.

[Open the live dashboard](https://varionsystemslab.github.io/aurora-australis-watch/)

_Automated alert from the daily aurora-alert workflow (threshold: ${THRESHOLD}${sws?.watch ? ", lowered by active SWS Aurora Watch" : ""}${swsAlertActive ? "; triggered by active BOM SWS Aurora Alert" : ""})._`;
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
