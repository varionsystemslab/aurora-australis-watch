# Aurora Australis Watch — Victoria

A live dashboard for assessing the most likely day, time, and location to see the Aurora Australis from Victoria, Australia.

**Live site:** https://varionsystemslab.github.io/aurora-australis-watch/

## What it shows

- **Right Now** — current planetary Kp index (NOAA SWPC, updated every minute)
- **Tonight's Outlook** — composite 0–100 likelihood score for tonight, with the best viewing location, dark viewing window, cloud cover, and moon phase
- **Best Locations Tonight** — seven Victorian viewing spots ranked by tonight's conditions (Wilsons Promontory, Inverloch, Phillip Island, Cape Schanck, Point Addis, Sorrento Back Beach, Werribee South)
- **Multi-Night Forecast** — up to ~27 nights ahead, with an adjustable alert threshold
- **Email Alert preview** — a ready-to-send alert email for the most likely upcoming night

## How scoring works

Score = 70% geomagnetic activity (forecast Kp index) + 20% cloud cover + 10% moon darkness, plus a small bonus for locations with a dark, open southern horizon. Victorian latitudes (~37.5–39°S) typically need Kp 6+ for camera-visible aurora and Kp 7+ for a realistic naked-eye chance — thresholds are rules of thumb from the aurora-chasing community, not guarantees.

## Data sources

- [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov/) — current Kp, 3-day forecast, 27-day outlook
- [Open-Meteo](https://open-meteo.com/) — nightly cloud cover per location (~16-day horizon)
- [SunCalc](https://github.com/mourner/suncalc) — moon illumination and astronomical darkness times

Plain HTML/CSS/JS, no build step. All data is fetched client-side; no API keys required.
