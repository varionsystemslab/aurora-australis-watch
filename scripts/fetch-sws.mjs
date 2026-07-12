// Fetches current aurora products from the Australian Bureau of Meteorology's
// Space Weather Service (SWS) data API and writes a small sws.json snapshot.
//
// Requires SWS_API_KEY in the environment. Without it, writes { available: false }
// so consumers can degrade gracefully. SWS timestamps are Australian Eastern
// Standard Time (UTC+10), not UTC.

import fs from "node:fs";

const API_BASE = "https://sws-data.sws.bom.gov.au/api/v1";
const KEY = process.env.SWS_API_KEY;

function aestToDate(s) {
  return new Date(s.replace(" ", "T") + "+10:00");
}

function melbourneToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

async function swsPost(product, options) {
  const res = await fetch(`${API_BASE}/${product}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ? { api_key: KEY, options } : { api_key: KEY })
  });
  if (!res.ok) throw new Error(`${product} failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(`${product} errors: ${JSON.stringify(json.errors)}`);
  return json.data || [];
}

let snapshot;
if (!KEY) {
  console.error("SWS_API_KEY not set — writing unavailable snapshot.");
  snapshot = { available: false, fetched_at: new Date().toISOString() };
} else {
  const [alerts, watches, outlooks, kIndex] = await Promise.all([
    swsPost("get-aurora-alert"),
    swsPost("get-aurora-watch"),
    swsPost("get-aurora-outlook"),
    swsPost("get-k-index", { location: "Australian region" })
  ]);

  const now = new Date();
  const today = melbourneToday();

  // Keep only notices that are still in force (the API can include recent history).
  const alert = alerts.find(a => a.valid_until && aestToDate(a.valid_until) >= now) || null;
  const activeSpan = n => n.end_date && n.end_date >= today;
  const watch = watches.find(activeSpan) || null;
  const outlook = outlooks.find(activeSpan) || null;
  const k = kIndex.length ? kIndex[kIndex.length - 1] : null;

  snapshot = {
    available: true,
    fetched_at: new Date().toISOString(),
    k_aus: k ? { index: k.index, valid_time: k.valid_time, analysis_time: k.analysis_time } : null,
    alert,
    watch,
    outlook
  };
}

fs.writeFileSync("sws.json", JSON.stringify(snapshot, null, 2) + "\n");
console.log("Wrote sws.json:", JSON.stringify(snapshot));
