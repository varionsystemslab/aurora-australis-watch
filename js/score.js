// Combines geomagnetic, cloud-cover and moon data into a single 0-100 likelihood score.
//
// Weighting: geomagnetic activity (Kp) is the dominant driver of whether aurora is visible
// at all from Victorian latitudes, so it carries most of the weight. Cloud cover and moon
// brightness only matter once there's something to see, so they act as modifiers.
const WEIGHTS = { geo: 0.7, cloud: 0.2, moon: 0.1 };

function scoreNight({ kp, cloudPct, moonFraction, horizonBonus = 0 }) {
  const geoScore = kpBand(kp).score;
  const cloudScore = (cloudPct == null) ? 70 : (100 - cloudPct);
  const moonScore = (moonFraction == null) ? 70 : (1 - moonFraction) * 100;

  const raw = geoScore * WEIGHTS.geo + cloudScore * WEIGHTS.cloud + moonScore * WEIGHTS.moon + horizonBonus;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, geoScore, cloudScore: cloudPct == null ? null : Math.round(cloudScore), moonScore: Math.round(moonScore) };
}

// Builds a per-night outlook (up to ~27 nights) for a single location by merging:
//  - detailed 3-day Kp forecast (first 3 nights, 3-hourly resolution)
//  - 27-day daily Kp outlook (remaining nights, daily resolution, less precise)
//  - nightly cloud cover (only available for the Open-Meteo forecast horizon, ~16 nights)
//  - moon illumination (computed for any date)
function buildNightlyOutlook({ threeDay, outlook27, cloudMap, location, today }) {
  const kpByDate = new Map();
  threeDay.forEach(n => kpByDate.set(n.date, { kp: n.nightMaxKp, precision: "3-hourly" }));
  outlook27.forEach(n => {
    if (!kpByDate.has(n.date)) kpByDate.set(n.date, { kp: n.kp, precision: "daily" });
  });

  // NOAA's 27-day outlook isn't reissued daily, so it can contain dates already in the
  // past relative to "today" — drop anything before today so forecasts/alerts never look backward.
  const dates = Array.from(kpByDate.keys()).filter(d => d >= today).sort();

  return dates.map(date => {
    const { kp, precision } = kpByDate.get(date);
    const cloudPct = cloudMap.has(date) ? cloudMap.get(date) : null;
    const moon = moonInfoFor(new Date(date + "T12:00:00"));
    const { score, geoScore, cloudScore, moonScore } = scoreNight({
      kp,
      cloudPct,
      moonFraction: moon.fraction,
      horizonBonus: location.horizonBonus
    });
    return {
      date, kp, kpPrecision: precision, cloudPct, moon,
      score, geoScore, cloudScore, moonScore,
      verdict: verdictFor(score)
    };
  });
}
