/* ============================================================
   Rainbow Likelihood Map -- app.js
   Vanilla JS, no frameworks, no build step.
   ============================================================ */

"use strict";

import { computeLikelihood } from "./core/likelihood.js";
import { pointsAround, cellKey } from "./core/points.js";
import { terrainOutlook } from "./core/terrain.js";
import { satelliteCovered, observedSky } from "./core/nowcast.js";
import { composeAlert } from "./core/alerts.js";
import { PUSH_SERVER_URL } from "./core/config.js";

// In the packaged mobile app (Capacitor shell) compute the forecast on-device.
// On the web, also compute on-device using the resolved GPS location.
const STANDALONE = typeof window !== "undefined" && !!window.Capacitor;
const PushPlugin = window.Capacitor?.Plugins?.PushNotifications;
const PUSH_CAPABLE = STANDALONE && !!PushPlugin && !!PUSH_SERVER_URL;
const LS_PUSH_ENABLED = "rainbow-push-enabled";
const LS_PUSH_TOKEN   = "rainbow-push-token";
const LS_LOCATION     = "rainbow-location";
const DEFAULT_LOCATION = { lat: 48.4284, lon: -123.3656, fallback: true };

let currentLocation = null;
const REFETCH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const UPDATED_TICK_MS = 30 * 1000;           // 30 seconds

const NOTIFY_THRESHOLD = 25;
const LS_NOTIFY_ENABLED = "rainbow-notify-enabled";
const LS_NOTIFIED       = "rainbow-notified";

// ── HTML escaping helper ────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Score / level helpers ───────────────────────────────────
function scoreToLevel(score) {
  if (score === 0)  return "none";
  if (score < 25)  return "low";
  if (score < 50)  return "moderate";
  if (score < 70)  return "good";
  return "high";
}

// Probability bands are lower than score bands (ensemble member agreement)
function probToLevel(p) {
  if (p === 0)  return "none";
  if (p < 10)  return "low";
  if (p < 25)  return "moderate";
  if (p < 45)  return "good";
  return "high";
}

// Level id -> the word users see (matches the legend vocabulary)
const LEVEL_WORD = { none: "unlikely", low: "slim", moderate: "fair", good: "good", high: "strong" };

// Level -> CSS color variable value
function levelToColor(level) {
  const map = {
    none:     "var(--color-none)",
    low:      "var(--color-low)",
    moderate: "var(--color-moderate)",
    good:     "var(--color-good)",
    high:     "var(--color-high)",
  };
  return map[level] || map.none;
}

// ── Relative time ───────────────────────────────────────────
function relativeTime(isoString) {
  if (!isoString) return "Unknown";
  const diffSec = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 10)  return "Just now";
  if (diffSec < 60)  return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60)  return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hr ago`;
}

// ── Build popup HTML ────────────────────────────────────────
// dayIndex: which day to display (0 = today). Hourly chart only for day 0.
function buildPopupContent(loc, dayIndex) {
  const d = loc.days?.[dayIndex] ?? loc;
  const level = d.level || scoreToLevel(d.score);

  // Chart section: today only
  let chartSection = "";
  if (dayIndex === 0) {
    const dayHours = (loc.hourly || []).filter(h => h.sunElevation > 0);
    const barValue = h => h.probability != null ? h.probability : h.score;
    const maxScore = dayHours.reduce((m, h) => Math.max(m, barValue(h)), 1);
    const CHART_HEIGHT = 46;

    let barsHtml = "";
    dayHours.forEach(h => {
      const val = barValue(h);
      const barLevel = h.probability != null ? probToLevel(val) : scoreToLevel(val);
      const isStub = val === 0;
      const barPx = isStub ? 2 : Math.max(4, Math.round((val / maxScore) * CHART_HEIGHT));
      const barClass = isStub ? "chart-bar bar-stub" : `chart-bar bar-${barLevel}`;
      let tooltip = h.probability != null
        ? `${esc(h.label)}: ${h.probability}% chance, score ${h.score}`
        : `${esc(h.label)}: score ${h.score}`;
      if (h.precipMm > 0) {
        tooltip += `, ${h.precipMm}mm ${esc(h.rainType || "rain")}`;
      } else if (h.rainType === "possible") {
        tooltip += ", chance of showers";
      }
      if (h.sunlitPct != null) {
        tooltip += `, sun ${h.sunlitPct}% of hour`;
      } else if (h.cloudCover != null) {
        tooltip += `, ${h.cloudCover}% cloud`;
      }
      barsHtml += `<div class="chart-col">` +
        `<div class="${barClass}" style="height:${barPx}px" title="${tooltip}"></div>` +
        `</div>`;
    });

    let labelsHtml = "";
    dayHours.forEach((h, i) => {
      const label = (i % 3 === 0) ? h.label.replace(" AM","a").replace(" PM","p") : "";
      labelsHtml += `<div class="chart-x-label">${esc(label)}</div>`;
    });

    chartSection = dayHours.length > 0 ? `
      <p class="popup-chart-label">Hourly (daytime)</p>
      <div class="popup-chart">${barsHtml}</div>
      <div class="chart-x-labels">${labelsHtml}</div>
    ` : "";
  }

  // 7-day strip: always shown; selected day gets chip-selected ring; chips are clickable
  let weekStripHtml = "";
  if (loc.days && loc.days.length > 0) {
    const chips = loc.days.map((day, i) => {
      const label = day.weekday;
      const val = day.probability != null ? `${day.probability}%` : day.score;
      const chipLevel = day.level || "none";
      const title = esc((i === 0 ? "Today: " : "") + (day.reason || ""));
      const extraClass = (i === dayIndex) ? " chip-selected" : (i === 0 ? " chip-today" : "");
      return `<div class="day-chip chip-${chipLevel}${extraClass}" data-day="${i}" title="${title}" style="cursor:pointer">` +
        `<span class="day-chip-label">${esc(label)}</span>` +
        `<span class="day-chip-val">${esc(val)}</span>` +
        `</div>`;
    }).join("");
    weekStripHtml = `
      <p class="popup-chart-label" style="margin-top:10px">Next 7 days</p>
      <div class="day-strip">${chips}</div>
    `;
  }

  // Plan block: when the bow is geometrically possible (d.bow), the score
  // expands into the actionable three: when to be out, where to face, how
  // high the sun sits. Terrain (a separate sightline score) fills in async
  // on popup open. Falls back to the plain best-hour line without geometry.
  let planHtml = "";
  if (d.bow) {
    const sharpest = (dayIndex === 0 && loc.bestWindow != null)
      ? `<span class="geo-sub"> · sharpest ${esc(loc.bestWindow)}</span>`
      : "";
    // Observed sky is a right-now reading, so today only, and only where a
    // real satellite sees (elsewhere the row is omitted, no empty promise).
    const skyRow = (dayIndex === 0 && satelliteCovered(loc.lat, loc.lon))
      ? `<div class="geo-row"><span class="geo-k">Sky now</span><span class="geo-v geo-sky-v">reading satellite&hellip;</span></div>`
      : "";
    planHtml = `<div class="popup-geo" data-lat="${loc.lat}" data-lon="${loc.lon}" data-sunaz="${d.bow.sunAzimuth}" data-sunel="${d.bow.sunElevation}">
      <div class="geo-row"><span class="geo-k">Best window</span><span class="geo-v">${esc(d.bow.window || d.bestHour || "")}${sharpest}</span></div>
      <div class="geo-row"><span class="geo-k">Look</span><span class="geo-v">${esc(d.bow.look)}</span></div>
      <div class="geo-row"><span class="geo-k">Sun</span><span class="geo-v">${d.bow.sunElevation}&deg; above the horizon</span></div>
      <div class="geo-row"><span class="geo-k">Terrain</span><span class="geo-v geo-terrain-v">checking sightlines&hellip;</span></div>
      ${skyRow}
    </div>`;
  } else if (d.bestHour) {
    planHtml = `<p class="popup-best-hour">Best hour: <strong>${esc(d.bestHour)}</strong></p>`;
  }

  const headline = d.probability != null ? `${d.probability}%` : d.score;

  // Conditions quality line: today only
  const qualityHtml = (dayIndex === 0 && loc.probability != null && loc.score > 0)
    ? `<p class="popup-quality">Conditions quality: ${loc.score}/100</p>`
    : "";

  return `<div class="popup-inner">
    <p class="popup-town">${esc(loc.name)}</p>
    <div class="popup-score-row">
      <span class="popup-score-num score-${level}">${headline}</span>
      <span class="popup-level-word score-${level}">${LEVEL_WORD[level] || level}</span>
    </div>
    ${qualityHtml}
    ${planHtml}
    <p class="popup-reason">${esc(d.reason || "")}</p>
    ${weekStripHtml}
    ${chartSection}
    ${dayIndex === 0 ? `<button class="sight-btn" data-loc="${esc(loc.name)}">I saw a rainbow!</button>` : ""}
  </div>`;
}

// ── Sighting recorder ───────────────────────────────────────
const LS_SIGHTINGS = "rainbow-sightings";
const MAX_SIGHTINGS = 200;

function recordSighting(loc) {
  let sightings = [];
  try { sightings = JSON.parse(localStorage.getItem(LS_SIGHTINGS) || "[]"); } catch (_) {}
  sightings.push({
    ts: Date.now(),
    lat: loc.lat,
    lon: loc.lon,
    name: loc.name,
    probability: loc.probability,
    score: loc.score,
    bestHour: loc.bestHour,
  });
  if (sightings.length > MAX_SIGHTINGS) sightings = sightings.slice(-MAX_SIGHTINGS);
  localStorage.setItem(LS_SIGHTINGS, JSON.stringify(sightings));
  showShareCard(loc);
}

// ── Share card canvas ───────────────────────────────────────
async function showShareCard(loc) {
  // Canvas will silently substitute fallback fonts if the webfonts are not
  // in the cache yet; wait for them so the card carries the brand type.
  try {
    await document.fonts.load("72px 'Instrument Serif'");
    await document.fonts.load("44px 'Instrument Sans'");
  } catch (_) { /* fall back to the declared serif/sans stacks */ }

  const W = 1080, H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#f5f2ea";
  ctx.fillRect(0, 0, W, H);

  // Border inset 40px
  ctx.strokeStyle = "#d8d2c4";
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, W - 80, H - 80);

  // Three-arc bow glyph + horizon, centered, ~220px wide
  const cx = W / 2;
  const horizonY = 340;
  const arcRadii = [110, 78, 46];
  const arcColors = ["#7a68d9", "#2f9e8f", "#dd9f2e"];
  arcColors.forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(cx, horizonY, arcRadii[i], Math.PI, 0, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = "butt";
    ctx.stroke();
  });
  // Horizon line
  ctx.beginPath();
  ctx.moveTo(cx - 130, horizonY);
  ctx.lineTo(cx + 130, horizonY);
  ctx.strokeStyle = "#232a35";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  ctx.stroke();

  // Headline
  ctx.fillStyle = "#232a35";
  ctx.textAlign = "center";
  ctx.font = "72px 'Instrument Serif', Georgia, serif";
  ctx.fillText("Rainbow spotted", cx, 470);

  // Sub line
  const locLabel = loc.name === "Your spot" ? "near me" : `near ${loc.name}`;
  ctx.fillStyle = "#5d6675";
  ctx.font = "44px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText(locLabel, cx, 540);

  // Big stat
  const pct = loc.probability ?? loc.score ?? 0;
  ctx.fillStyle = "#5b48c2";
  ctx.font = "200px 'Instrument Serif', Georgia, serif";
  ctx.fillText(`${pct}%`, cx, 800);

  // Caption
  const caption = "Bowcast called it" + (loc.bestHour ? ` for ${loc.bestHour}` : "");
  ctx.fillStyle = "#5d6675";
  ctx.font = "40px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText(caption, cx, 890);

  // Bottom branding
  ctx.fillStyle = "#232a35";
  ctx.font = "36px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText("bowcast · rainbow forecast", cx, 1240);
  ctx.fillText("bowcast.app", cx, 1290);

  // Share or download
  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], "bowcast-rainbow.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        text: "I caught a rainbow that Bowcast predicted",
      });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bowcast-rainbow.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    if (err.name !== "AbortError") console.warn("share card error:", err);
  }

  // Button feedback (best-effort: popup may still be open)
  const btn = document.querySelector(`.sight-btn[data-loc="${CSS.escape(loc.name)}"]`);
  if (btn) {
    btn.textContent = "Logged!";
    btn.disabled = true;
  }
}

// ── Build marker icon: the bow gauge ────────────────────────
// Probability drawn as a spectral arc over a horizon line (the brand's
// signature element): a tiny landscape with a bow rising as chances do.
const LEVEL_HEX = { none: "#a9a294", low: "#7a68d9", moderate: "#2f9e8f", good: "#dd9f2e", high: "#d95f52" };
const GAUGE_ARC_LEN = 47.1; // semicircle length for r=15

function buildIcon(loc, dayIndex) {
  const d = loc.days?.[dayIndex] ?? loc;
  const level = d.level || scoreToLevel(d.score);
  const isProb = d.probability != null;
  const val = isProb ? d.probability : d.score;
  const label = isProb ? `${val}%` : String(val);
  const isHome = loc.name === "Your spot";
  const frac = val > 0 ? Math.max(0.07, Math.min(val / 100, 1)) : 0;
  const html = `<div class="gauge${isHome ? " gauge-home" : ""}${level === "high" ? " gauge-high" : ""}">
    <svg viewBox="0 0 46 42" width="46" height="42" aria-hidden="true">
      <rect class="gauge-plaque" x="1" y="1" width="44" height="40" rx="11"/>
      <path class="gauge-track" d="M8 32 A15 15 0 0 1 38 32"/>
      <path class="gauge-arc" d="M8 32 A15 15 0 0 1 38 32" stroke="${LEVEL_HEX[level]}" stroke-dasharray="${(frac * GAUGE_ARC_LEN).toFixed(1)} ${GAUGE_ARC_LEN.toFixed(1)}"/>
      <line class="gauge-horizon" x1="6" y1="32" x2="40" y2="32"/>
    </svg>
    <span class="gauge-val${isProb ? " gauge-pct" : ""}">${label}</span>
  </div>`;
  return L.divIcon({
    html,
    className: "",
    iconSize:   [46, 42],
    iconAnchor: [23, 21],
    popupAnchor: [0, -24],
  });
}

// ── Legend control ──────────────────────────────────────────
function addLegend(map) {
  const Legend = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const div = L.DomUtil.create("div");
      div.id = "legend";
      div.innerHTML = `
        <h3>Rainbow chance</h3>
        <div class="legend-row"><div class="legend-swatch swatch-high"></div><span class="legend-text">45%+&nbsp;&nbsp;&nbsp; Strong chance</span></div>
        <div class="legend-row"><div class="legend-swatch swatch-good"></div><span class="legend-text">25–44% Good</span></div>
        <div class="legend-row"><div class="legend-swatch swatch-moderate"></div><span class="legend-text">10–24% Fair</span></div>
        <div class="legend-row"><div class="legend-swatch swatch-low"></div><span class="legend-text">1–9%&nbsp;&nbsp;&nbsp; Slim</span></div>
        <div class="legend-row"><div class="legend-swatch swatch-none"></div><span class="legend-text">0%&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Unlikely</span></div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  new Legend().addTo(map);
}

// ── Main init ───────────────────────────────────────────────
async function init() {
  // DOM refs
  const updatedText   = document.getElementById("updated-text");
  const refreshBtn    = document.getElementById("refresh-btn");
  const locateBtn     = document.getElementById("locate-btn");
  const searchBtn     = document.getElementById("search-btn");
  const notifyBtn     = document.getElementById("notify-btn");
  const errorBanner   = document.getElementById("error-banner");
  const errorMessage  = document.getElementById("error-message");
  const errorRetryBtn = document.getElementById("error-retry-btn");
  const errorCloseBtn = document.getElementById("error-close-btn");
  const loadingOverlay  = document.getElementById("loading-overlay");
  const mapContainer    = document.getElementById("map-container");
  const outlookBanner   = document.getElementById("outlook-banner");
  const outlookText     = document.getElementById("outlook-text");
  const dayBar          = document.getElementById("day-bar");
  const locationPanel   = document.getElementById("location-panel");
  const locationHint    = document.getElementById("location-hint");
  const useGpsBtn       = document.getElementById("use-gps-btn");
  const locationSearch  = document.getElementById("location-search");
  const locationResults = document.getElementById("location-results");

  // State
  let generatedAt = null;
  let markers = [];
  let refetchTimer = null;
  let updatedTimer = null;
  let lastBounds = null;
  let userMoved = false;  // once the user pans/zooms, stop auto-fitting
  let autoFit = false;
  let lastData = null;    // last successful API response, used for checkNotify
  let selectedDay = 0;
  let lastLocations = null;
  let lastOutlook = null;
  let todayMax = 0;
  let suppressFitUntil = 0;
  let openTown = null;
  let hintShown = false;  // auto-open panel once per session on fallback location

  // ── Location resolution ───────────────────────────────────
  async function resolveLocation({ refresh = false } = {}) {
    // URL deep-link: ?lat=48.4&lon=-123.3&label=Victoria
    // Consumed once on first load; replaceState strips the query so subsequent
    // calls (including refresh:true) never see these params again.
    if (!refresh) {
      const params = new URLSearchParams(window.location.search);
      const urlLat = parseFloat(params.get("lat"));
      const urlLon = parseFloat(params.get("lon"));
      if (isFinite(urlLat) && isFinite(urlLon) && Math.abs(urlLat) <= 90 && Math.abs(urlLon) <= 180) {
        const urlLoc = { lat: urlLat, lon: urlLon };
        const urlLabel = params.get("label");
        if (urlLabel) urlLoc.label = urlLabel;
        localStorage.setItem(LS_LOCATION, JSON.stringify(urlLoc));
        history.replaceState(null, "", window.location.pathname);
        return urlLoc;
      }
    }
    if (!refresh) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_LOCATION) || "null");
        if (saved && typeof saved.lat === "number" && typeof saved.lon === "number") return saved;
      } catch (_) {}
    }
    const Geo = window.Capacitor?.Plugins?.Geolocation;
    try {
      let coords = null;
      if (STANDALONE && Geo) {
        coords = (await Geo.getCurrentPosition({ enableHighAccuracy: false, timeout: 10000 })).coords;
      } else if (navigator.geolocation) {
        coords = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), reject, { timeout: 10000, maximumAge: 600000 }));
      }
      if (coords) {
        const loc = { lat: Math.round(coords.latitude * 1e4) / 1e4, lon: Math.round(coords.longitude * 1e4) / 1e4 };
        localStorage.setItem(LS_LOCATION, JSON.stringify(loc));
        return loc;
      }
    } catch (err) {
      console.warn("geolocation unavailable:", err && (err.message || err.code));
    }
    return DEFAULT_LOCATION;
  }

  // Reverse-geocode the ring points and keep only ones on land (somewhere a
  // person could actually be), relabeled with the real place instead of
  // "12 km NE". Keyless BigDataCloud; a point over open water returns no
  // country, so it is dropped. Any failure keeps the point, so a geocoder
  // outage never blanks the map. Cached by rounded coordinate.
  const geoCache = new Map();
  async function reverseGeo(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (geoCache.has(key)) return geoCache.get(key);
    let out = { land: true, label: null };
    try {
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      if (r.ok) {
        const d = await r.json();
        out = { land: Boolean(d.countryName), label: d.locality || d.city || d.principalSubdivision || null };
      }
    } catch (_) { /* keep the point on failure */ }
    geoCache.set(key, out);
    return out;
  }

  // Batched terrain elevation (one Open-Meteo call). The DEM reads 0 or below
  // over sea/strait/ocean and the real height on land, which separates coastal
  // water (in territorial waters, so it still has a country) from land.
  async function elevationsFor(points) {
    try {
      const lat = points.map((p) => p.lat).join(',');
      const lon = points.map((p) => p.lon).join(',');
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
      if (r.ok) return (await r.json()).elevation || null;
    } catch (_) { /* fall back to the reverse-geocoder's country test */ }
    return null;
  }

  async function relevantPointsAround(lat, lon) {
    const pts = pointsAround(lat, lon);
    const ring = pts.slice(1);
    const [elev, geos] = await Promise.all([
      elevationsFor(pts),
      Promise.all(ring.map((p) => reverseGeo(p.lat, p.lon))),
    ]);
    const kept = [pts[0]]; // the user's own spot always stays, land or not
    ring.forEach((p, i) => {
      // Keep land (relabeled with the real place); drop points over open water.
      const onLand = elev ? elev[i + 1] > 0 : geos[i].land;
      if (onLand) kept.push({ ...p, name: geos[i].label || p.name });
    });
    return kept;
  }

  async function getLikelihood() {
    currentLocation = await resolveLocation();
    const points = await relevantPointsAround(currentLocation.lat, currentLocation.lon);
    return computeLikelihood(points);
  }

  // ── Map setup ─────────────────────────────────────────────
  const map = L.map("map", {
    center: [48.45, -123.45],
    zoom: 11,
    zoomControl: true,
  });

  // CARTO Positron: a pale, desaturated basemap so spectral color appears
  // only where it means something (the gauges).
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  addLegend(map);

  // Fit the view to all markers. The container can be measured at the wrong
  // size during initial load (and changes on rotation / error banner), so we
  // re-fit via ResizeObserver until the user takes over the view.
  function fitAll() {
    if (!lastBounds || !lastBounds.isValid()) return;
    // Never fit against a zero-size container (hidden/prerendered tab):
    // the resulting zoom is garbage. The observer will refit once visible.
    const el = document.getElementById("map");
    if (!el.offsetWidth || !el.offsetHeight) return;
    autoFit = true;
    map.invalidateSize();
    map.fitBounds(lastBounds, { padding: [48, 48], maxZoom: 13, animate: false });
    setTimeout(() => { autoFit = false; }, 0);
  }

  map.on("zoomstart dragstart", () => {
    if (!autoFit) userMoved = true;
  });

  new ResizeObserver(() => {
    if (Date.now() < suppressFitUntil) { map.invalidateSize(); return; }
    if (!userMoved) fitAll();
  }).observe(document.getElementById("map"));

  // ── UI helpers ────────────────────────────────────────────
  function showLoading(on) {
    loadingOverlay.classList.toggle("hidden", !on);
    refreshBtn.classList.toggle("spinning", on);
    refreshBtn.disabled = on;
  }

  function showError(msg) {
    // Error takes priority -- hide outlook banner to avoid double-shift
    outlookBanner.hidden = true;
    errorMessage.textContent = msg;
    errorBanner.hidden = false;
    const bh = errorBanner.offsetHeight;
    suppressFitUntil = Date.now() + 600;
    mapContainer.style.top = `calc(var(--header-offset) + ${bh}px)`;
  }

  function hideError() {
    errorBanner.hidden = true;
    suppressFitUntil = Date.now() + 600;
    mapContainer.style.top = "";
    updateOutlookBanner();
  }

  // ── Outlook banner (day-aware) ────────────────────────────
  // Show only when selectedDay === 0 AND todayMax === 0.
  // When outlook.dayIndex > 0, make it clickable to jump to that day.
  function updateOutlookBanner() {
    if (!lastLocations) { hideOutlook(); return; }
    if (selectedDay !== 0 || todayMax !== 0) {
      hideOutlook();
      return;
    }

    let msg;
    const o = lastOutlook;
    if (o && o.dayIndex > 0) {
      const val = o.probability != null
        ? `${o.probability}%`
        : `${o.score}/100`;
      const hourPart = o.bestHour ? ` around ${o.bestHour}` : "";
      msg = `Next chance: ${o.weekday}, ${o.town} ${val}${hourPart} →`;
    } else {
      msg = "No rainbow setup in the next 7 days. Dry stretch ahead.";
    }
    showOutlook(msg, o && o.dayIndex > 0 ? o.dayIndex : null);
  }

  function showOutlook(msg, clickDay) {
    outlookText.textContent = msg;
    outlookBanner.hidden = false;
    if (clickDay != null) {
      outlookBanner.setAttribute("role", "button");
      outlookBanner.setAttribute("tabindex", "0");
      outlookBanner.style.cursor = "pointer";
      outlookBanner._clickDay = clickDay;
    } else {
      outlookBanner.removeAttribute("role");
      outlookBanner.removeAttribute("tabindex");
      outlookBanner.style.cursor = "";
      outlookBanner._clickDay = null;
    }
    if (errorBanner.hidden) {
      const bh = outlookBanner.offsetHeight;
      suppressFitUntil = Date.now() + 600;
      mapContainer.style.top = `calc(var(--header-offset) + ${bh}px)`;
    }
  }

  function hideOutlook() {
    outlookBanner.hidden = true;
    if (errorBanner.hidden) {
      suppressFitUntil = Date.now() + 600;
      mapContainer.style.top = "";
    }
  }

  // Banner heights are measured at show time; re-assert on viewport changes
  // so a wrapped or unwrapped banner never leaves a stale map offset.
  let bannerResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(bannerResizeTimer);
    bannerResizeTimer = setTimeout(() => {
      if (!errorBanner.hidden) {
        suppressFitUntil = Date.now() + 600;
        mapContainer.style.top = `calc(var(--header-offset) + ${errorBanner.offsetHeight}px)`;
      } else {
        updateOutlookBanner();
      }
    }, 150);
  });

  outlookBanner.addEventListener("click", () => {
    if (outlookBanner._clickDay != null) {
      selectDay(outlookBanner._clickDay);
    }
  });
  outlookBanner.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && outlookBanner._clickDay != null) {
      e.preventDefault();
      selectDay(outlookBanner._clickDay);
    }
  });

  function tickUpdated() {
    if (!generatedAt) { updatedText.textContent = "-"; return; }
    // When the ensemble API is unavailable or rate-limited, the map falls back
    // to the deterministic quality score (0-100), not a probability. Flag it so
    // a bare "4" is not mistaken for a broken percentage (matches the Now page).
    const ensembleOn = Array.isArray(lastLocations) && lastLocations.some((l) => l.probability != null);
    updatedText.textContent = `Updated ${relativeTime(generatedAt)}` + (ensembleOn ? "" : " · quality scores");
  }

  function startUpdatedTicker() {
    clearInterval(updatedTimer);
    tickUpdated();
    updatedTimer = setInterval(tickUpdated, UPDATED_TICK_MS);
  }

  // ── Clear markers ─────────────────────────────────────────
  function clearMarkers() {
    markers.forEach(m => m.remove());
    markers = [];
  }

  // ── Render locations ──────────────────────────────────────
  // fit:true (default) updates lastBounds and calls fitAll (post-fetch behavior).
  // fit:false skips refit so day switching keeps pan/zoom.
  function renderLocations(locations, dayIndex, { fit = true } = {}) {
    clearMarkers();

    const bounds = L.latLngBounds();

    locations.forEach(loc => {
      const icon = buildIcon(loc, dayIndex);
      const marker = L.marker([loc.lat, loc.lon], { icon, title: loc.name });

      marker.bindPopup(buildPopupContent(loc, dayIndex), {
        maxWidth: 310,
        minWidth: 260,
      });

      marker.addTo(map);
      markers.push(marker);
      bounds.extend([loc.lat, loc.lon]);
    });

    if (fit && locations.length > 0 && bounds.isValid()) {
      lastBounds = bounds;
      fitAll();
    }
  }

  // ── Day bar ───────────────────────────────────────────────
  // Builds the pill of day tabs from lastLocations data.
  function buildDayBar(locations) {
    if (!locations || !locations.length) {
      dayBar.hidden = true;
      return;
    }

    // Determine number of days from the first location with days
    const numDays = (locations[0].days || []).length;
    if (numDays === 0) {
      dayBar.hidden = true;
      return;
    }

    dayBar.innerHTML = "";
    dayBar.hidden = false;

    for (let i = 0; i < numDays; i++) {
      // Compute max value over all locations for day i
      let hasProb = false;
      let maxVal = 0;
      locations.forEach(loc => {
        const day = loc.days?.[i];
        if (!day) return;
        if (day.probability != null) {
          hasProb = true;
          maxVal = Math.max(maxVal, day.probability);
        } else {
          maxVal = Math.max(maxVal, day.score ?? 0);
        }
      });

      const level = hasProb ? probToLevel(maxVal) : scoreToLevel(maxVal);
      const valLabel = hasProb ? `${maxVal}%` : String(maxVal);

      // Weekday label: from any location's days[i].weekday
      let weekday = "";
      for (const loc of locations) {
        if (loc.days?.[i]?.weekday) { weekday = loc.days[i].weekday; break; }
      }
      // Abbreviate to 3 uppercase chars
      const weekdayShort = weekday.slice(0, 3).toUpperCase();

      const isSelected = (i === selectedDay);

      const btn = document.createElement("button");
      btn.className = "day-tab" + (isSelected ? " day-tab-selected" : "");
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      btn.setAttribute("type", "button");
      btn.title = weekday || `Day ${i}`;

      // Today gets an indigo dot marker
      const dotHtml = (i === 0)
        ? `<span class="day-tab-today-dot" aria-hidden="true"></span>`
        : "";

      const TAB_VAL_COLORS = { none: "#6f6a5e", low: "#5b48c2", moderate: "#22766b", good: "#9c6d10", high: "#b0392e" };
      const tabValColor = TAB_VAL_COLORS[level] || TAB_VAL_COLORS.none;
      btn.innerHTML = `${dotHtml}<span class="day-tab-weekday">${esc(weekdayShort)}</span><span class="day-tab-val" style="color:${tabValColor}">${esc(valLabel)}</span>`;

      btn.addEventListener("click", () => selectDay(i));

      dayBar.appendChild(btn);
    }
  }

  // ── Select a day ──────────────────────────────────────────
  // Central routine: updates selectedDay, rebuilds bar styles, re-renders
  // markers without refitting, updates outlook banner.
  function selectDay(i) {
    if (!lastLocations) return;
    const numDays = (lastLocations[0]?.days || []).length;
    selectedDay = Math.max(0, Math.min(i, numDays - 1));
    const reopen = openTown;
    buildDayBar(lastLocations);
    renderLocations(lastLocations, selectedDay, { fit: false });
    updateOutlookBanner();
    if (reopen) {
      const m = markers.find(mk => mk.options.title === reopen);
      if (m) m.openPopup();
    }
  }

  // ── Popup chip click wiring ───────────────────────────────
  // Registered once; handles any popup opened after this point.
  map.on("popupopen", (e) => {
    openTown = e.popup._source?.options?.title ?? null;
    const popupEl = e.popup.getElement();
    if (!popupEl) return;
    popupEl.querySelectorAll(".day-chip[data-day]").forEach(chip => {
      chip.addEventListener("click", () => {
        const idx = parseInt(chip.dataset.day, 10);
        if (!isNaN(idx)) selectDay(idx);
      });
    });
    const sightBtn = popupEl.querySelector(".sight-btn");
    if (sightBtn) {
      sightBtn.addEventListener("click", () => {
        if (sightBtn.disabled) return; // guard against double-recording
        sightBtn.disabled = true;
        const name = sightBtn.dataset.loc;
        const loc = lastLocations && lastLocations.find(l => l.name === name);
        if (loc) recordSighting(loc);
      });
    }
    // Terrain sightline check, on demand: one batched elevation request per
    // spot and sun direction, memoized in core/terrain.js, so reopening a
    // popup (or switching days on the same azimuth) is instant.
    const geoEl = popupEl.querySelector(".popup-geo[data-lat]");
    if (geoEl) {
      const valEl = geoEl.querySelector(".geo-terrain-v");
      terrainOutlook(
        parseFloat(geoEl.dataset.lat),
        parseFloat(geoEl.dataset.lon),
        parseFloat(geoEl.dataset.sunaz),
        parseFloat(geoEl.dataset.sunel),
      ).then(t => {
        if (!valEl) return;
        valEl.innerHTML = `${esc(t.word)} (${t.score}/100)` +
          `<span class="geo-sub"> · ${esc(t.reason.split("; ")[0])}</span>`;
        valEl.title = t.reason;
      }).catch(() => {
        if (valEl) valEl.textContent = "sightline check unavailable";
      });

      // Observed sky, right now, from satellite (covered regions only).
      const skyValEl = geoEl.querySelector(".geo-sky-v");
      if (skyValEl) {
        observedSky(parseFloat(geoEl.dataset.lat), parseFloat(geoEl.dataset.lon)).then(s => {
          const row = skyValEl.closest(".geo-row");
          if (!s.covered || !s.observed) { if (row) row.remove(); return; }
          const age = s.ageMin <= 5 ? "just now" : `${s.ageMin} min ago`;
          skyValEl.innerHTML = `${esc(s.state)}<span class="geo-sub"> · ${s.dni} W/m² beam, ${age}</span>`;
          skyValEl.title = `Satellite direct normal irradiance ${s.dni} W/m², observed ${age}`;
        }).catch(() => {
          const row = skyValEl.closest(".geo-row");
          if (row) row.remove();
        });
      }
    }
  });

  map.on("popupclose", () => { openTown = null; });

  // ── Fetch data ────────────────────────────────────────────
  async function fetchData() {
    showLoading(true);
    hideError();

    try {
      const data = await getLikelihood();

      generatedAt = data.generatedAt || null;
      lastData = data;
      startUpdatedTicker();

      if (Array.isArray(data.locations)) {
        lastLocations = data.locations;
        lastOutlook = data.outlook || null;

        // Clamp selectedDay to available days
        const numDays = (lastLocations[0]?.days || []).length;
        if (numDays > 0) {
          selectedDay = Math.max(0, Math.min(selectedDay, numDays - 1));
        }

        // Compute todayMax (today's values, index 0 or top-level)
        todayMax = lastLocations.reduce(
          (m, l) => Math.max(m, l.probability ?? l.score ?? 0),
          0
        );

        buildDayBar(lastLocations);
        renderLocations(lastLocations, selectedDay, { fit: true });
        updateOutlookBanner();
      }

      checkNotify(data);

      // Auto-open the location panel once per session when on fallback location
      if (!hintShown && currentLocation && currentLocation.fallback) {
        hintShown = true;
        openLocationPanel(false); // no focus: don't pop the keyboard on load
      }
    } catch (err) {
      console.error("Failed to fetch rainbow data:", err);
      showError(`Couldn't load data: ${err.message}. Check your connection.`);
      updatedText.textContent = "Failed to load";
    } finally {
      // Reflect locate button state on success and error alike
      if (currentLocation && currentLocation.fallback) {
        locateBtn.classList.add("locate-fallback");
        locateBtn.title = "Using default location (Victoria BC). Tap to use your location.";
      } else if (currentLocation) {
        locateBtn.classList.remove("locate-fallback");
        locateBtn.title = "Use my location";
      }
      showLoading(false);
    }

    // Schedule next auto-refetch
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(fetchData, REFETCH_INTERVAL_MS);
  }

  // ── Notification helpers ──────────────────────────────────
  // Note: alerts fire only while a tab of the app is open.
  // Closed-tab alerts require service-worker Web Push, which needs HTTPS.

  function notifyEnabled() {
    return localStorage.getItem(LS_NOTIFY_ENABLED) === "1" &&
           Notification.permission === "granted";
  }

  function updateNotifyBtn() {
    if (STANDALONE) {
      if (!PUSH_CAPABLE) {
        notifyBtn.hidden = true;
        return;
      }
      notifyBtn.hidden = false;
      notifyBtn.disabled = false;
      if (localStorage.getItem(LS_PUSH_ENABLED) === "1") {
        notifyBtn.title = "Rainbow push alerts on (25%+). Click to turn off";
        notifyBtn.className = "notify-on";
      } else {
        notifyBtn.title = "Get push alerts when any town's rainbow chance reaches 25%";
        notifyBtn.className = "notify-off";
      }
      return;
    }
    if (!("Notification" in window)) {
      notifyBtn.hidden = true;
      return;
    }
    if (Notification.permission === "denied") {
      notifyBtn.disabled = true;
      notifyBtn.title = "Notifications are blocked in your browser settings";
      notifyBtn.className = "notify-off";
      return;
    }
    if (notifyEnabled()) {
      notifyBtn.disabled = false;
      notifyBtn.title = "Rainbow alerts on (25%+). Click to turn off";
      notifyBtn.className = "notify-on";
    } else {
      notifyBtn.disabled = false;
      notifyBtn.title = "Notify me when any town's rainbow chance reaches 25%";
      notifyBtn.className = "notify-off";
    }
  }

  function checkNotify(data) {
    if (STANDALONE) return;
    if (!notifyEnabled() || !data) return;

    const today = new Date().toDateString();

    // Load and prune old notified keys (keep only today's entries)
    let notified = {};
    try { notified = JSON.parse(localStorage.getItem(LS_NOTIFIED) || "{}"); } catch (_) {}
    Object.keys(notified).forEach(k => {
      if (!k.includes(`|${today}|`)) delete notified[k];
    });

    // Key includes the ~25 km cell so moving to a new city never suppresses
    // alerts deduped under the same relative name ("12 km NE") elsewhere.
    const dedupeKey = (l) => `${cellKey(l.lat, l.lon)}|${l.name}|${today}|${l.bestHour}`;

    const qualifying = data.locations.filter(l => (l.probability ?? 0) >= NOTIFY_THRESHOLD);
    const unnotified = qualifying.filter(l => !notified[dedupeKey(l)]);

    if (unnotified.length > 0) {
      // Lead with the strongest spot in the shared alert voice; the rest
      // fold into a count instead of a wall of lines.
      const top = unnotified.reduce((a, b) => ((b.probability ?? 0) > (a.probability ?? 0) ? b : a));
      const { title, body } = composeAlert(top);
      const extra = unnotified.length > 1 ? `\n+${unnotified.length - 1} more spots nearby` : "";
      const n = new Notification(title, {
        body: body + extra,
        tag: "rainbow-alert",
      });
      n.onclick = () => window.focus();

      unnotified.forEach(l => {
        notified[dedupeKey(l)] = true;
      });
      localStorage.setItem(LS_NOTIFIED, JSON.stringify(notified));
    }
  }

  async function togglePush() {
    if (!PUSH_CAPABLE) return;
    if (localStorage.getItem(LS_PUSH_ENABLED) === "1") {
      const token = localStorage.getItem(LS_PUSH_TOKEN);
      if (token) {
        try {
          await fetch(`${PUSH_SERVER_URL}/api/push/unregister`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
        } catch (err) { console.warn("push unregister failed:", err.message); }
      }
      localStorage.removeItem(LS_PUSH_ENABLED);
      localStorage.removeItem(LS_PUSH_TOKEN);
      updateNotifyBtn();
      return;
    }
    try {
      const perm = await PushPlugin.requestPermissions();
      if (perm.receive !== "granted") return;
      notifyBtn.disabled = true;
      notifyBtn.title = "Enabling push alerts...";
      await PushPlugin.register();
      // the 'registration' listener completes enrollment and re-enables the button
    } catch (err) {
      console.warn("push enable failed:", err.message || err);
      showError("Could not enable push alerts on this device.");
    } finally {
      // registration listener may still be pending; make the button usable
      // again regardless (the listener calls updateNotifyBtn once more)
      notifyBtn.disabled = false;
      updateNotifyBtn();
    }
  }

  function initPushListeners() {
    if (!PUSH_CAPABLE) return;
    PushPlugin.addListener("registration", async (t) => {
      try {
        // The registration event can fire before the first forecast resolves
        // the location; resolve it here so the server never gets null coords.
        const loc = currentLocation ?? (currentLocation = await resolveLocation());
        const resp = await fetch(`${PUSH_SERVER_URL}/api/push/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t.value, platform: window.Capacitor.getPlatform(), lat: loc?.lat ?? null, lon: loc?.lon ?? null }) });
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        localStorage.setItem(LS_PUSH_ENABLED, "1");
        localStorage.setItem(LS_PUSH_TOKEN, t.value);
      } catch (err) {
        console.warn("push registration failed:", err.message);
        showError("Could not reach the alert server. Push alerts stay off.");
      }
      updateNotifyBtn();
    });
    PushPlugin.addListener("registrationError", (e) => {
      console.warn("push registration error:", JSON.stringify(e));
      updateNotifyBtn();
    });
  }

  notifyBtn.addEventListener("click", async () => {
    if (STANDALONE) { await togglePush(); return; }
    if (notifyEnabled()) {
      localStorage.removeItem(LS_NOTIFY_ENABLED);
      updateNotifyBtn();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem(LS_NOTIFY_ENABLED, "1");
      updateNotifyBtn();
      new Notification("Bowcast alerts on", {
        body: "You'll get a ping when any town reaches a 25%+ chance while this tab is open.",
      });
      checkNotify(lastData);
    } else {
      updateNotifyBtn();
    }
  });

  // ── Location panel ────────────────────────────────────────
  function openLocationPanel(focusSearch = true) {
    locationSearch.value = "";
    locationResults.innerHTML = "";
    // The in-panel GPS retry only appears in the fallback/denied flow; the
    // header target button is the everyday "use my location" control.
    locationHint.hidden = !(currentLocation && currentLocation.fallback);
    useGpsBtn.hidden = locationHint.hidden;
    locationPanel.hidden = false;
    if (focusSearch) locationSearch.focus();
  }

  function closeLocationPanel() {
    locationPanel.hidden = true;
  }

  function toggleLocationPanel() {
    if (locationPanel.hidden) {
      openLocationPanel();
    } else {
      closeLocationPanel();
    }
  }

  function renderResults(results) {
    locationResults.innerHTML = "";
    if (!results || results.length === 0) return;
    results.forEach((r, idx) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.tabIndex = 0;

      const name = document.createTextNode(r.name);
      li.appendChild(name);

      const secondary = [r.admin1, r.country_code].filter(Boolean).join(", ");
      if (secondary) {
        const sep = document.createTextNode(" ");
        li.appendChild(sep);
        const span = document.createElement("span");
        span.className = "location-result-secondary";
        span.textContent = secondary;
        li.appendChild(span);
      }

      const pick = () => {
        localStorage.setItem(LS_LOCATION, JSON.stringify({ lat: r.latitude, lon: r.longitude, label: r.name }));
        userMoved = false;
        closeLocationPanel();
        fetchData();
      };

      li.addEventListener("click", pick);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });

      li.dataset.idx = idx;
      locationResults.appendChild(li);
    });
  }

  let searchTimer = null;
  let lastSearchResults = [];
  let searchSeq = 0; // guards against out-of-order responses

  locationSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = locationSearch.value.trim();
    if (q.length < 2) {
      locationResults.innerHTML = "";
      lastSearchResults = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const resp = await fetch(
          "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(q) + "&count=5&language=en&format=json"
        );
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const json = await resp.json();
        if (seq !== searchSeq) return; // a newer search superseded this one
        lastSearchResults = json.results || [];
        renderResults(lastSearchResults);
      } catch (_) {
        if (seq !== searchSeq) return;
        lastSearchResults = [];
        locationResults.innerHTML = "";
        const li = document.createElement("li");
        li.className = "location-result-error";
        li.textContent = "Search failed. Try again.";
        locationResults.appendChild(li);
      }
    }, 300);
  });

  locationSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeLocationPanel();
    } else if (e.key === "Enter") {
      if (lastSearchResults.length > 0) {
        const r = lastSearchResults[0];
        localStorage.setItem(LS_LOCATION, JSON.stringify({ lat: r.latitude, lon: r.longitude, label: r.name }));
        userMoved = false;
        closeLocationPanel();
        fetchData();
      }
    }
  });

  useGpsBtn.addEventListener("click", () => {
    localStorage.removeItem(LS_LOCATION);
    userMoved = false;
    closeLocationPanel();
    fetchData();
  });

  // Close panel when clicking outside it or #locate-btn
  document.addEventListener("click", (e) => {
    if (locationPanel.hidden) return;
    if (locationPanel.contains(e.target) || searchBtn.contains(e.target)) return;
    closeLocationPanel();
  });

  // ── Event listeners ───────────────────────────────────────
  // Target button = use my location directly (same action as the panel's
  // GPS retry). Magnifier button = the search panel.
  locateBtn.addEventListener("click", () => {
    localStorage.removeItem(LS_LOCATION);
    userMoved = false;
    closeLocationPanel();
    fetchData();
  });

  searchBtn.addEventListener("click", () => {
    toggleLocationPanel();
  });

  refreshBtn.addEventListener("click", fetchData);

  errorRetryBtn.addEventListener("click", fetchData);

  errorCloseBtn.addEventListener("click", () => {
    hideError();
  });

  // ── Kick off ──────────────────────────────────────────────
  updateNotifyBtn();
  initPushListeners();
  await fetchData();
}

// ── Bootstrap ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  init().catch(err => console.error("Init error:", err));
});
