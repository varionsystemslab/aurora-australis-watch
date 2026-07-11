// Static reference data: Victorian aurora-viewing locations and scoring constants.

const LOCATIONS = [
  {
    id: "wilsons-prom",
    name: "Wilsons Promontory (Norman Beach / Squeaky Beach)",
    lat: -39.03,
    lon: 146.314,
    note: "Victoria's southernmost point, dark sky, unobstructed southern horizon.",
    horizonBonus: 6
  },
  {
    id: "cape-schanck",
    name: "Cape Schanck, Mornington Peninsula",
    lat: -38.508,
    lon: 144.894,
    note: "South-facing cliffs, easy access, moderate light pollution from Melbourne glow to the north.",
    horizonBonus: 4
  },
  {
    id: "phillip-island",
    name: "Phillip Island (Cape Woolamai / Pyramid Rock)",
    lat: -38.547,
    lon: 145.335,
    note: "Popular aurora-chasing spot, open southern horizon over Bass Strait.",
    horizonBonus: 4
  },
  {
    id: "inverloch",
    name: "Inverloch / Cape Paterson",
    lat: -38.645,
    lon: 145.706,
    note: "Dark South Gippsland coastline, low light pollution.",
    horizonBonus: 5
  },
  {
    id: "point-addis",
    name: "Point Addis, Great Ocean Road",
    lat: -38.398,
    lon: 144.113,
    note: "South/south-west facing, dark skies west of Torquay.",
    horizonBonus: 4
  },
  {
    id: "werribee-south",
    name: "Werribee South (beach / river mouth)",
    lat: -38.017,
    lon: 144.699,
    note: "Very convenient for Melbourne's west; faces south-east over Port Phillip Bay, but strong sky-glow from Melbourne and Geelong limits faint displays.",
    horizonBonus: 1
  },
  {
    id: "sorrento-back-beach",
    name: "Sorrento / Blairgowrie Back Beach",
    lat: -38.366,
    lon: 144.771,
    note: "Convenient for Melbourne, some light pollution from the bay side.",
    horizonBonus: 2
  }
];

// Approximate geomagnetic-activity thresholds for naked-eye/camera aurora visibility
// from Victorian latitudes (~37.5-39S). These are community/citizen-science rules of
// thumb (e.g. Aurora Australis Tasmania & Victoria chasing groups), not a guarantee.
const KP_BANDS = [
  { min: 0, max: 4, score: 5, label: "Quiet — unlikely, even from the far south coast" },
  { min: 4, max: 5, score: 20, label: "Unsettled — camera may pick up a faint glow from dark southern coasts" },
  { min: 5, max: 6, score: 40, label: "Active — camera-visible glow likely from southern coasts; slim naked-eye chance" },
  { min: 6, max: 7, score: 60, label: "Minor storm — good camera visibility, naked-eye possible from dark coasts" },
  { min: 7, max: 8, score: 80, label: "Moderate storm — naked-eye visibility likely from most of Victoria's coast" },
  { min: 8, max: 10, score: 100, label: "Strong-severe storm — naked-eye visibility likely, even with some light pollution" }
];

function kpBand(kp) {
  for (const b of KP_BANDS) {
    if (kp >= b.min && kp < b.max) return b;
  }
  return KP_BANDS[KP_BANDS.length - 1];
}

const VERDICTS = [
  { min: 0, label: "Low", className: "verdict-low" },
  { min: 30, label: "Fair", className: "verdict-fair" },
  { min: 50, label: "Good", className: "verdict-good" },
  { min: 70, label: "Excellent", className: "verdict-excellent" }
];

function verdictFor(score) {
  let v = VERDICTS[0];
  for (const item of VERDICTS) {
    if (score >= item.min) v = item;
  }
  return v;
}
