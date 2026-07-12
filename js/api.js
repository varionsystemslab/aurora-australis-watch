// Fetching & parsing of live space-weather and weather data.
// Sources: NOAA Space Weather Prediction Center (SWPC) text/JSON products, Open-Meteo.

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function fetchWithRetry(url, { retries = 3, baseDelayMs = 600 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429 && attempt < retries) {
      await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
      continue;
    }
    throw new Error(url + " fetch failed: " + res.status);
  }
}

function isoDate(year, monthAbbr, day) {
  const m = MONTHS.indexOf(monthAbbr);
  return `${year}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Current estimated planetary Kp (updated every minute by SWPC).
async function fetchCurrentKp() {
  const res = await fetchWithRetry("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json");
  const rows = await res.json();
  const last = rows[rows.length - 1];
  return { kp: parseFloat(last.kp_index), time: last.time_tag };
}

// Detailed 3-hourly Kp forecast for the next 3 days, from NOAA's 3-day forecast text product.
// Returns [{ date: "YYYY-MM-DD", nightMaxKp: number, buckets: [...] }]
async function fetchThreeDayForecast() {
  const res = await fetchWithRetry("https://services.swpc.noaa.gov/text/3-day-forecast.txt");
  const text = await res.text();

  const issuedMatch = text.match(/:Issued:\s*(\d{4})/);
  const year = issuedMatch ? issuedMatch[1] : new Date().getFullYear().toString();

  const headerMatch = text.match(/NOAA Kp index breakdown[^\n]*\n\s*\n?\s*([A-Za-z]{3}\s+\d{1,2})\s+([A-Za-z]{3}\s+\d{1,2})\s+([A-Za-z]{3}\s+\d{1,2})/);
  if (!headerMatch) throw new Error("Could not locate Kp breakdown header in NOAA forecast text");

  const dateLabels = [headerMatch[1], headerMatch[2], headerMatch[3]].map(lbl => {
    const [mon, day] = lbl.trim().split(/\s+/);
    return isoDate(year, mon, day);
  });

  const bucketRe = /^\d{2}-\d{2}UT\s+([\d.]+)\s*\((\d+)\)\s+([\d.]+)\s*\((\d+)\)\s+([\d.]+)\s*\((\d+)\)\s*$/gm;
  const buckets = [[], [], []]; // one array of rounded Kp per date
  let m;
  while ((m = bucketRe.exec(text)) !== null) {
    buckets[0].push(parseInt(m[2], 10));
    buckets[1].push(parseInt(m[4], 10));
    buckets[2].push(parseInt(m[6], 10));
  }

  // Night window = last 4 of the 8 three-hourly buckets (~19:00 local through ~07:00 next morning, AEST).
  return dateLabels.map((date, i) => {
    const dayBuckets = buckets[i];
    const nightBuckets = dayBuckets.slice(4); // buckets 09-12,12-15,15-18,18-21 UT
    const nightMaxKp = nightBuckets.length ? Math.max(...nightBuckets) : Math.max(...dayBuckets, 0);
    return { date, nightMaxKp, buckets: dayBuckets };
  });
}

// Daily predicted Kp for the next 27 days, from NOAA's 27-day outlook text product.
// Returns [{ date: "YYYY-MM-DD", kp: number }]
async function fetchTwentySevenDayOutlook() {
  const res = await fetchWithRetry("https://services.swpc.noaa.gov/text/27-day-outlook.txt");
  const text = await res.text();

  const rowRe = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/gm;
  const out = [];
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const [, year, mon, day, , , kp] = m;
    out.push({ date: isoDate(year, mon, day), kp: parseInt(kp, 10) });
  }
  return out;
}

// Nightly average cloud cover (%) for the next `days` days at a given lat/lon.
// Night = local hours >= 19:00 (that evening) through < 06:00 (next morning).
// Returns a Map from "YYYY-MM-DD" (the evening's date) to average cloud cover %.
async function fetchNightlyCloudCover(lat, lon, days = 16) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloudcover&timezone=Australia%2FMelbourne&forecast_days=${days}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();

  const times = data.hourly.time;
  const clouds = data.hourly.cloudcover;
  const buckets = new Map(); // date -> array of cloud% values

  for (let i = 0; i < times.length; i++) {
    const [datePart, timePart] = times[i].split("T");
    const hour = parseInt(timePart.slice(0, 2), 10);
    let nightDate = datePart;
    if (hour < 6) {
      // belongs to the previous evening's night
      const d = new Date(datePart + "T00:00:00");
      d.setDate(d.getDate() - 1);
      nightDate = d.toISOString().slice(0, 10);
    } else if (hour < 19) {
      continue; // daytime hour, not part of any night window
    }
    if (!buckets.has(nightDate)) buckets.set(nightDate, []);
    buckets.get(nightDate).push(clouds[i]);
  }

  const avg = new Map();
  for (const [date, vals] of buckets) {
    avg.set(date, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return avg;
}

// BOM SWS status snapshot (Australian K index + aurora alert/watch/outlook notices),
// published hourly by the sws-status GitHub Action. The SWS API itself needs a key,
// so the browser reads this pre-fetched snapshot instead. Returns null if unavailable.
async function fetchSwsStatus() {
  const urls = [
    "sws.json", // local dev / same-origin copy, if present
    "https://raw.githubusercontent.com/varionsystemslab/aurora-australis-watch/sws-data/sws.json?t=" + Date.now()
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.available) return data;
    } catch { /* try next source */ }
  }
  return null;
}

// Moon illumination fraction (0-1) and phase name for a given date, using SunCalc.
function moonInfoFor(date) {
  const illum = SunCalc.getMoonIllumination(date);
  const fraction = illum.fraction; // 0 = new, 1 = full
  let phaseName = "New Moon";
  const p = illum.phase; // 0-1
  if (p < 0.03 || p > 0.97) phaseName = "New Moon";
  else if (p < 0.22) phaseName = "Waxing Crescent";
  else if (p < 0.28) phaseName = "First Quarter";
  else if (p < 0.47) phaseName = "Waxing Gibbous";
  else if (p < 0.53) phaseName = "Full Moon";
  else if (p < 0.72) phaseName = "Waning Gibbous";
  else if (p < 0.78) phaseName = "Last Quarter";
  else phaseName = "Waning Crescent";
  return { fraction, phaseName };
}

// Astronomical darkness window for tonight at a given location (approx viewing window).
function darknessWindowFor(date, lat, lon) {
  const times = SunCalc.getTimes(date, lat, lon);
  // nauticalDusk/nauticalDawn approximate "dark enough" bounds for aurora viewing.
  return { start: times.nauticalDusk, end: times.nauticalDawn };
}
