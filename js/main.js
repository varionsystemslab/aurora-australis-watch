const ALERT_RECIPIENT = "varionsystemslab@gmail.com";
const DEFAULT_THRESHOLD = 55;

const state = {
  currentKp: null,
  outlooksByLocation: new Map(), // locationId -> nightly outlook array
  threshold: DEFAULT_THRESHOLD,
  selectedLocationId: LOCATIONS[0].id
};

function melbourneToday() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // YYYY-MM-DD
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function fmtTime(date) {
  if (!date || isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne" });
}

async function init() {
  const banner = document.getElementById("status-banner");
  try {
    banner.textContent = "Fetching live space-weather and cloud-cover data…";

    const [currentKp, threeDay, outlook27] = await Promise.all([
      fetchCurrentKp(),
      fetchThreeDayForecast(),
      fetchTwentySevenDayOutlook()
    ]);
    state.currentKp = currentKp;

    const today = melbourneToday();
    // Fetched sequentially (not in parallel) to stay under Open-Meteo's burst rate limit.
    for (const loc of LOCATIONS) {
      const cloudMap = await fetchNightlyCloudCover(loc.lat, loc.lon, 16);
      const outlook = buildNightlyOutlook({ threeDay, outlook27, cloudMap, location: loc, today });
      state.outlooksByLocation.set(loc.id, outlook);
    }

    banner.style.display = "none";
    renderAll();
  } catch (err) {
    console.error(err);
    banner.textContent = "Couldn't load live data (" + err.message + "). NOAA/Open-Meteo may be temporarily unavailable — try refreshing shortly.";
    banner.classList.add("error");
  }
}

function renderAll() {
  renderRightNow();
  renderTonight();
  renderLocationRanking();
  renderForecastTable();
  renderEmailPreview();
}

function renderRightNow() {
  const el = document.getElementById("right-now");
  const { kp, time } = state.currentKp;
  const band = kpBand(kp);
  el.innerHTML = `
    <div class="kp-value">${kp.toFixed(2)}</div>
    <div class="kp-label">Current planetary Kp index</div>
    <div class="kp-band">${band.label}</div>
    <div class="kp-updated">Updated ${new Date(time.replace(" ", "T") + "Z").toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" })} (Melbourne time)</div>
  `;
}

// Restricted to nights with an actual cloud-cover forecast (~16 days out), so the
// headline recommendation is never driven by the "unknown cloud" neutral default.
function bestNightAcrossLocations() {
  let best = null;
  for (const [locId, outlook] of state.outlooksByLocation) {
    for (const night of outlook) {
      if (night.cloudPct == null) continue;
      if (!best || night.score > best.score) {
        best = { ...night, locationId: locId };
      }
    }
  }
  return best;
}

function renderTonight() {
  const today = melbourneToday();
  const el = document.getElementById("tonight");
  const rows = LOCATIONS.map(loc => {
    const outlook = state.outlooksByLocation.get(loc.id);
    const night = outlook.find(n => n.date === today) || outlook[0];
    return { loc, night };
  }).sort((a, b) => b.night.score - a.night.score);

  const top = rows[0];
  const moon = top.night.moon;
  const darkness = darknessWindowFor(new Date(top.night.date + "T12:00:00"), top.loc.lat, top.loc.lon);

  el.innerHTML = `
    <div class="tonight-score ${top.night.verdict.className}">${top.night.score}</div>
    <div class="tonight-verdict ${top.night.verdict.className}">${top.night.verdict.label}</div>
    <div class="tonight-detail">Best bet tonight: <strong>${top.loc.name}</strong></div>
    <div class="tonight-detail">Forecast Kp: <strong>${top.night.kp}</strong> (${top.night.kpPrecision}) — ${kpBand(top.night.kp).label}</div>
    <div class="tonight-detail">Cloud cover: <strong>${top.night.cloudPct == null ? "no forecast yet" : Math.round(top.night.cloudPct) + "%"}</strong></div>
    <div class="tonight-detail">Moon: <strong>${moon.phaseName}</strong> (${Math.round(moon.fraction * 100)}% illuminated)</div>
    <div class="tonight-detail">Dark viewing window: <strong>${fmtTime(darkness.start)} – ${fmtTime(darkness.end)}</strong> (nautical dusk–dawn)</div>
  `;
}

function renderLocationRanking() {
  const today = melbourneToday();
  const el = document.getElementById("location-ranking");
  const rows = LOCATIONS.map(loc => {
    const outlook = state.outlooksByLocation.get(loc.id);
    const night = outlook.find(n => n.date === today) || outlook[0];
    return { loc, night };
  }).sort((a, b) => b.night.score - a.night.score);

  el.innerHTML = rows.map(({ loc, night }) => `
    <div class="location-row">
      <div class="location-rank">${night.score}</div>
      <div class="location-info">
        <div class="location-name">${loc.name}</div>
        <div class="location-note">${loc.note}</div>
      </div>
      <div class="location-verdict ${night.verdict.className}">${night.verdict.label}</div>
    </div>
  `).join("");
}

function renderForecastTable() {
  const sel = document.getElementById("location-select");
  if (!sel.options.length) {
    sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}">${l.name}</option>`).join("");
    sel.value = state.selectedLocationId;
    sel.addEventListener("change", () => {
      state.selectedLocationId = sel.value;
      renderForecastTable();
    });
  }

  const outlook = state.outlooksByLocation.get(state.selectedLocationId);
  const thresholdInput = document.getElementById("threshold-input");
  const tbody = document.getElementById("forecast-body");

  tbody.innerHTML = outlook.map(n => `
    <tr class="${n.score >= state.threshold ? "row-alert" : ""}">
      <td>${fmtDate(n.date)}</td>
      <td>${n.kp} <span class="precision">(${n.kpPrecision})</span></td>
      <td>${n.cloudPct == null ? "—" : Math.round(n.cloudPct) + "%"}</td>
      <td>${Math.round(n.moon.fraction * 100)}%</td>
      <td class="${n.verdict.className}">${n.score}</td>
      <td class="${n.verdict.className}">${n.verdict.label}${n.score >= state.threshold ? " 🔔" : ""}</td>
    </tr>
  `).join("");

  thresholdInput.value = state.threshold;
}

function generateAlertEmail() {
  const best = bestNightAcrossLocations();
  const loc = LOCATIONS.find(l => l.id === best.locationId);
  const darkness = darknessWindowFor(new Date(best.date + "T12:00:00"), loc.lat, loc.lon);
  const subject = `Aurora Australis alert: ${best.verdict.label} chance on ${fmtDate(best.date)}`;
  const body =
`Aurora Australis Watch — Victoria

Most likely night in the current outlook: ${fmtDate(best.date)}
Likelihood score: ${best.score}/100 (${best.verdict.label})
Best location: ${loc.name}
Forecast Kp index: ${best.kp} (${best.kpPrecision}) — ${kpBand(best.kp).label}
Cloud cover: ${best.cloudPct == null ? "no forecast yet" : Math.round(best.cloudPct) + "%"}
Moon: ${best.moon.phaseName} (${Math.round(best.moon.fraction * 100)}% illuminated)
Dark viewing window: ${fmtTime(darkness.start)} - ${fmtTime(darkness.end)} (nautical dusk-dawn, Melbourne time)

Face south toward an open, unobstructed horizon. Give your eyes 15-20 minutes to adjust to the dark, and check for a faint glow or coloured pillars low on the southern horizon — cameras (even phone night mode) often pick up colour the naked eye can't.

Generated by the Aurora Australis dashboard.`;

  return { subject, body, to: ALERT_RECIPIENT };
}

function renderEmailPreview() {
  const el = document.getElementById("email-preview");
  const { subject, body, to } = generateAlertEmail();
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  el.innerHTML = `
    <div class="email-field"><span>To</span> ${to}</div>
    <div class="email-field"><span>Subject</span> ${subject}</div>
    <pre class="email-body">${body}</pre>
    <a class="mailto-button" href="${mailto}">Open email to send now</a>
  `;
}

document.getElementById("threshold-input")?.addEventListener("change", e => {
  state.threshold = parseInt(e.target.value, 10) || DEFAULT_THRESHOLD;
  renderForecastTable();
});

init();
