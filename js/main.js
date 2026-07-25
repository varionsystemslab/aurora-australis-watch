const ALERT_RECIPIENT = "varionsystemslab@gmail.com";
const HOME_LOCATION_ID = "werribee-south"; // default drive spot
const DEFAULT_DRIVE_KP = 7;                 // "worth the drive" naked-eye threshold

const state = {
  currentKp: null,
  sws: null, // BOM SWS snapshot (Kaus + notices), or null if unavailable
  outlooksByLocation: new Map(), // locationId -> nightly outlook array
  driveKp: DEFAULT_DRIVE_KP,
  selectedLocationId: HOME_LOCATION_ID
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

    const [currentKp, threeDay, outlook27, sws] = await Promise.all([
      fetchCurrentKp(),
      fetchThreeDayForecast(),
      fetchTwentySevenDayOutlook(),
      fetchSwsStatus() // resolves to null on failure, never throws
    ]);
    state.currentKp = currentKp;
    state.sws = sws;

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

function swsStatusHtml() {
  const sws = state.sws;
  if (!sws) {
    return `<div class="sws-status sws-none">BOM SWS status unavailable — showing NOAA data only.</div>`;
  }
  if (sws.alert) {
    return `<div class="sws-status sws-alert">⚠ <strong>BOM Aurora ALERT active now</strong> — ${sws.alert.description || "aurora conditions occurring"} (lat band: ${sws.alert.lat_band || "?"}, valid until ${sws.alert.valid_until} AEST)</div>`;
  }
  if (sws.watch) {
    return `<div class="sws-status sws-watch">👁 <strong>BOM Aurora Watch</strong> — ${sws.watch.start_date} to ${sws.watch.end_date} (${sws.watch.cause || "activity expected"})</div>`;
  }
  if (sws.outlook) {
    return `<div class="sws-status sws-outlook">🔭 <strong>BOM Aurora Outlook</strong> — ${sws.outlook.start_date} to ${sws.outlook.end_date} (${sws.outlook.cause || "possible activity"})</div>`;
  }
  return `<div class="sws-status sws-quiet">BOM SWS: no active aurora notices</div>`;
}

function renderRightNow() {
  const el = document.getElementById("right-now");
  const { kp, time } = state.currentKp;
  const band = kpBand(kp);
  const kaus = state.sws?.k_aus;
  el.innerHTML = `
    <div class="kp-duo">
      <div class="kp-cell">
        <div class="kp-value">${kp.toFixed(2)}</div>
        <div class="kp-label">Planetary Kp (NOAA)</div>
      </div>
      ${kaus ? `
      <div class="kp-cell">
        <div class="kp-value">${kaus.index}</div>
        <div class="kp-label">Australian K index (BOM)</div>
      </div>` : ""}
    </div>
    <div class="kp-band">${band.label}</div>
    <div class="kp-updated">Updated ${new Date(time.replace(" ", "T") + "Z").toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" })} (Melbourne time)</div>
    ${swsStatusHtml()}
  `;
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

  tbody.innerHTML = outlook.map(n => {
    const driveWorthy = n.kp >= state.driveKp;
    return `
    <tr class="${driveWorthy ? "row-alert" : ""}">
      <td>${fmtDate(n.date)}</td>
      <td>${n.kp} <span class="precision">(${n.kpPrecision})</span></td>
      <td>${n.cloudPct == null ? "—" : Math.round(n.cloudPct) + "%"}</td>
      <td>${Math.round(n.moon.fraction * 100)}%</td>
      <td class="${n.verdict.className}">${n.score}</td>
      <td class="${n.verdict.className}">${n.verdict.label}${driveWorthy ? " 🔔" : ""}</td>
    </tr>`;
  }).join("");

  thresholdInput.value = state.driveKp;
}

// Anchored on the home location (Werribee). Emails when an upcoming night is forecast
// to reach the Kp drive threshold; otherwise previews the best upcoming night and notes
// that it's below the drive bar.
function generateAlertEmail() {
  const home = LOCATIONS.find(l => l.id === HOME_LOCATION_ID);
  const outlook = state.outlooksByLocation.get(home.id);
  const qualifying = outlook
    .filter(n => n.kp >= state.driveKp)
    .sort((a, b) => b.kp - a.kp || b.score - a.score || a.date.localeCompare(b.date));
  const driveNight = qualifying[0] || null;
  const night = driveNight || [...outlook].sort((a, b) => b.score - a.score)[0];
  const darkness = darknessWindowFor(new Date(night.date + "T12:00:00"), home.lat, home.lon);

  const subject = driveNight
    ? `Aurora: Kp ${driveNight.kp} forecast ${fmtDate(driveNight.date)} — worth the drive to Werribee`
    : `Aurora outlook: no Kp ${state.driveKp}+ night yet (best Kp ${night.kp}, ${fmtDate(night.date)})`;

  const lead = driveNight
    ? `Forecast conditions reach Kp ${driveNight.kp} on ${fmtDate(driveNight.date)} — at or above your Kp ${state.driveKp} drive threshold.`
    : `Nothing reaches your Kp ${state.driveKp} drive threshold in the current outlook. The best upcoming night at ${home.name} is below — shown here as a heads-up only.`;

  const body =
`Aurora Australis Watch — Victoria

${lead}

Night: ${fmtDate(night.date)}
Forecast Kp index: ${night.kp} (${night.kpPrecision}) — ${kpBand(night.kp).label}
Your spot: ${home.name}
Viewing score there: ${night.score}/100 (${night.verdict.label})
Cloud cover: ${night.cloudPct == null ? "no forecast yet" : Math.round(night.cloudPct) + "%"}
Moon: ${night.moon.phaseName} (${Math.round(night.moon.fraction * 100)}% illuminated)
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
  const v = parseInt(e.target.value, 10);
  state.driveKp = Number.isFinite(v) ? Math.max(0, Math.min(9, v)) : DEFAULT_DRIVE_KP;
  renderForecastTable();
  renderEmailPreview();
});

init();
