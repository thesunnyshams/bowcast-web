/* ============================================================
   Rainbow Likelihood Map -- app.js
   Vanilla JS, no frameworks, no build step.
   ============================================================ */

"use strict";

import { computeLikelihood } from "./core/likelihood.js";
import { pointsAround, cellKey } from "./core/points.js";
import { terrainOutlook } from "./core/terrain.js";
import { satelliteCovered, observedSky } from "./core/nowcast.js";
import { composeAlert, alertEligible } from "./core/alerts.js";
import { initThemeToggles } from "./theme.js";
import { METRICS_SERVER_URL, PUSH_SERVER_URL, SIGHTING_SERVER_URL } from "./core/config.js?v=16";
import { CITIES } from "./core/cities.js";
import {
  FORECAST_INTERVAL_SCHEMA_VERSION,
  intervalAt,
} from "./core/forecast-time.js";
import { sightingSharePayload, sightingShareValue } from "./core/share.js";
import { selectBestForecast } from "./core/presentation.js";
import { fetchWithTimeout } from "./core/http.js";
import {
  METRIC_SCHEMA_VERSION,
  METRIC_EVENTS,
  METRIC_SOURCES,
  metricMeasurementAllowed,
} from "./core/metrics.js";

// Packaged mobile apps compute forecasts on-device. The web prefers Bowcast's
// shared cache, with the same browser-safe engine as its resilient fallback.
const STANDALONE = typeof window !== "undefined" && !!window.Capacitor;
if (!STANDALONE && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.warn('offline support registration failed:', error.message);
  }));
}
const PushPlugin = window.Capacitor?.Plugins?.PushNotifications;
const PUSH_CAPABLE = STANDALONE && !!PushPlugin && !!PUSH_SERVER_URL;
const LS_PUSH_ENABLED = "rainbow-push-enabled";
const LS_PUSH_TOKEN   = "rainbow-push-token";
const LS_LOCATION     = "rainbow-location";
const LS_LOCATION_CHOICE_SEEN = "rainbow-location-choice-seen";
const DEFAULT_LOCATION = { lat: 48.4284, lon: -123.3656, fallback: true };

let currentLocation = null;
const REFETCH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const UPDATED_TICK_MS = 30 * 1000;           // 30 seconds
const FORECAST_STALE_AFTER_MS = 30 * 60 * 1000;

const NOTIFY_THRESHOLD = 25;
const LS_NOTIFY_ENABLED = "rainbow-notify-enabled";
const LS_NOTIFIED       = "rainbow-notified";
const RAINBOW_PLACES = CITIES.filter((city) => city.rainbowPlace);
const METRIC_EVENT_SET = new Set(METRIC_EVENTS);
const sentSessionMetrics = new Set();

function metricsAllowed() {
  return metricMeasurementAllowed(navigator);
}

function recordMetric(event) {
  if (!metricsAllowed() || !METRIC_EVENT_SET.has(event) || sentSessionMetrics.has(event)) return;
  sentSessionMetrics.add(event);
  const endpoint = METRICS_SERVER_URL ? `${METRICS_SERVER_URL}/api/metrics` : "/api/metrics";
  const reportedSource = reportSource();
  const source = METRIC_SOURCES.includes(reportedSource) ? reportedSource : "unknown";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: METRIC_SCHEMA_VERSION, event, source }),
    keepalive: true,
  }).catch(() => {
    // Aggregate counters are best effort and never block the forecast flow.
  });
}

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
        ? `${esc(h.label)}: ${h.probability}% estimated chance, conditions score ${h.score}/100`
        : `${esc(h.label)}: conditions score ${h.score}/100`;
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
      const axisLabel = h.startLabel || h.label;
      const label = (i % 3 === 0) ? axisLabel.replace(" AM","a").replace(" PM","p") : "";
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
      const val = day.probability != null ? `${day.probability}%` : `${day.score}/100`;
      const chipLevel = day.level || "none";
      const title = esc((i === 0 ? "Today: " : "") + (day.reason || ""));
      const extraClass = (i === dayIndex) ? " chip-selected" : (i === 0 ? " chip-today" : "");
      const selected = i === dayIndex ? "true" : "false";
      const ariaLabel = esc(`${label}: ${val}. ${i === 0 ? "Today. " : ""}${day.reason || ""}`);
      return `<button type="button" class="day-chip chip-${chipLevel}${extraClass}" data-day="${i}" title="${title}" aria-label="${ariaLabel}" aria-pressed="${selected}">` +
        `<span class="day-chip-label">${esc(label)}</span>` +
        `<span class="day-chip-val">${esc(val)}</span>` +
        `</button>`;
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
      <div class="geo-row"><span class="geo-k">Best window</span><span class="geo-v">${esc(d.bow.window || d.bestInterval || d.bestHour || "")}${sharpest}</span></div>
      <div class="geo-row"><span class="geo-k">Look</span><span class="geo-v">${esc(d.bow.look)}</span></div>
      <div class="geo-row"><span class="geo-k">Sun</span><span class="geo-v">${d.bow.sunElevation}&deg; above the horizon</span></div>
      <div class="geo-row"><span class="geo-k">Terrain</span><span class="geo-v geo-terrain-v">checking sightlines&hellip;</span></div>
      ${skyRow}
    </div>`;
  } else if (d.bestInterval || d.bestHour) {
    planHtml = `<p class="popup-best-hour">Best forecast interval: <strong>${esc(d.bestInterval || d.bestHour)}</strong></p>`;
  }

  const hasEstimate = d.probability != null;
  const headline = hasEstimate ? `${d.probability}%` : `${d.score}/100`;
  const peakLabel = dayIndex === 0 ? "Today's peak" : "Selected-day peak";
  const valueKind = `${peakLabel} ${hasEstimate ? "Estimated chance" : "Conditions score"}`;

  // Day 0 only: when the whole-day peak interval has already ended, say so
  // plainly (the headline number is retrospective) and point at the next
  // still-ahead peak when there is one.
  let peakedHtml = "";
  if (dayIndex === 0 && loc.bestIntervalEndEpoch != null
      && loc.bestIntervalEndEpoch * 1000 <= Date.now()) {
    const np = loc.nextPeak;
    const nextBit = np
      ? ` <span class="popup-peaked-next">Next: ${esc(np.interval || "")} ${np.probability != null ? np.probability + "%" : np.score + "/100"}</span>`
      : "";
    peakedHtml = `<p class="popup-peaked">Peaked earlier: ${esc(loc.bestInterval || loc.bestHour || "")}${nextBit}</p>`;
  }

  // Conditions quality line: today only
  const qualityHtml = !hasEstimate
    ? `<p class="popup-quality">Ensemble guidance is unavailable. This /100 score measures forecast ingredients, not probability.</p>`
    : (dayIndex === 0 && loc.score > 0)
      ? `<p class="popup-quality">Conditions score: ${loc.score}/100</p>`
      : "";

  return `<div class="popup-inner">
    <p class="popup-town">${esc(loc.name)}</p>
    <p class="popup-value-kind">${valueKind}</p>
    <div class="popup-score-row">
      <span class="popup-score-num score-${level}">${headline}</span>
      <span class="popup-level-word score-${level}">${LEVEL_WORD[level] || level}</span>
    </div>
    ${qualityHtml}
    ${peakedHtml}
    ${planHtml}
    <p class="popup-reason">${esc(d.reason || "")}</p>
    ${(weekStripHtml || chartSection) ? `<details class="popup-details">
      <summary>Week and hourly detail</summary>
      ${weekStripHtml}
      ${chartSection}
    </details>` : ""}
    ${dayIndex === 0 ? `<div class="sighting-report">
      <p class="sighting-title">Help calibrate Bowcast</p>
      <p class="sighting-copy">Optional: send a yes or no outcome with the forecast, time, and location rounded to about 1 km. No account or device ID. <a href="../privacy.html">Privacy</a></p>
      <div class="sighting-actions">
        <button class="sight-btn" data-loc="${esc(loc.name)}" data-outcome="seen">I saw one</button>
        <button class="sight-btn sight-btn-secondary" data-loc="${esc(loc.name)}" data-outcome="not_seen">I looked, no rainbow</button>
      </div>
      <p class="sighting-status" role="status" aria-live="polite"></p>
    </div>` : ""}
  </div>`;
}

// ── Anonymous calibration reports ───────────────────────────
const LS_SIGHTINGS = "rainbow-sightings";
const LS_SIGHTING_OUTBOX = "rainbow-sighting-outbox-v1";
const MAX_SIGHTINGS = 200;

function reportId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadLocalList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function saveLocalList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value.slice(-MAX_SIGHTINGS)));
    return true;
  } catch (_) {
    return false;
  }
}

function sightingEndpoint() {
  const origin = STANDALONE ? SIGHTING_SERVER_URL : "";
  return origin ? `${origin}/api/sightings` : "/api/sightings";
}

async function sendSightingReport(report) {
  const response = await fetch(sightingEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
  if (response.ok) return response.json();
  const error = new Error(`report endpoint returned ${response.status}`);
  error.terminal = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw error;
}

let sightingFlushPromise = null;

async function flushSightingOutbox(statusEl = null) {
  // Serialize retries. A startup retry and a newly submitted report can
  // otherwise overwrite each other's localStorage snapshot.
  while (sightingFlushPromise) await sightingFlushPromise;
  const pending = loadLocalList(LS_SIGHTING_OUTBOX);
  if (!pending.length) return;

  const run = async () => {
    const completedIds = new Set();
    let sent = 0;
    let rejected = 0;
    for (const report of pending) {
      try {
        await sendSightingReport(report);
        completedIds.add(report.id);
        sent += 1;
      } catch (error) {
        if (error.terminal) {
          completedIds.add(report.id);
          rejected += 1;
        }
      }
    }

    // Re-read before writing so reports added during this network pass remain.
    const latest = loadLocalList(LS_SIGHTING_OUTBOX);
    const remaining = latest.filter((report) => !completedIds.has(report.id));
    saveLocalList(LS_SIGHTING_OUTBOX, remaining);
    if (statusEl) {
      if (sent) statusEl.textContent = "Anonymous report sent. Thank you.";
      else if (rejected) statusEl.textContent = "This report could not be accepted.";
      else statusEl.textContent = "Saved on this device. Bowcast will retry when the report service is available.";
    }
  };

  sightingFlushPromise = run().finally(() => { sightingFlushPromise = null; });
  return sightingFlushPromise;
}

function reportSource() {
  if (STANDALONE) return window.Capacitor?.getPlatform?.() || "unknown";
  return window.matchMedia?.("(display-mode: standalone)")?.matches ? "pwa" : "web";
}

function buildSightingReport(loc, outcome, generatedAt) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const hourly = loc.hourly || [];
  const hour = intervalAt(hourly, nowEpoch) || hourly.reduce((best, candidate) => {
    if (!best) return candidate;
    const candidateEpoch = candidate.validForEpoch ?? candidate.epoch;
    const bestEpoch = best.validForEpoch ?? best.epoch;
    return Math.abs(candidateEpoch - nowEpoch) < Math.abs(bestEpoch - nowEpoch) ? candidate : best;
  }, null);
  const probability = hour?.probability ?? loc.probability ?? null;
  const rawProbability = hour?.rawProbability ?? loc.rawProbability ?? probability;
  const score = hour?.score ?? loc.score ?? null;
  return {
    id: reportId(),
    consent: true,
    outcome,
    observedAt: new Date().toISOString(),
    source: reportSource(),
    // Round before transmission as well as on the server.
    lat: Math.round(loc.lat * 100) / 100,
    lon: Math.round(loc.lon * 100) / 100,
    forecast: {
      generatedAt: generatedAt || null,
      validForEpoch: hour?.validForEpoch ?? hour?.epoch ?? null,
      validFromEpoch: hour?.validFromEpoch ?? hour?.epoch ?? null,
      validToEpoch: hour?.validToEpoch ?? null,
      probability,
      rawProbability,
      score,
      scoringVersion: loc.scoringVersion ?? null,
      calibrationVersion: loc.calibrationVersion ?? null,
      verificationToken: hour?.reportToken ?? null,
      evidence: probability != null ? "ensemble" : "deterministic",
      conditions: {
        precipMm: hour?.precipMm ?? null,
        precipProb: hour?.precipProb ?? null,
        cloudCover: hour?.cloudCover ?? null,
        sunlitPct: hour?.sunlitPct ?? null,
        sunElevation: hour?.sunElevation ?? null,
        rainType: hour?.rainType ?? null,
      },
    },
  };
}

function recordSighting(loc, outcome, generatedAt, statusEl) {
  const report = buildSightingReport(loc, outcome, generatedAt);
  const history = loadLocalList(LS_SIGHTINGS);
  history.push(report);
  const savedHistory = saveLocalList(LS_SIGHTINGS, history);
  const outbox = loadLocalList(LS_SIGHTING_OUTBOX);
  outbox.push(report);
  const savedOutbox = saveLocalList(LS_SIGHTING_OUTBOX, outbox);
  if (!savedHistory || !savedOutbox) {
    statusEl.textContent = "This browser could not save the report. Check site-storage permissions and try again.";
    return false;
  }
  recordMetric("sighting_reported");
  statusEl.textContent = "Saved on this device. Sending the anonymous report…";
  flushSightingOutbox(statusEl);
  if (outcome === "seen") showShareCard(loc, report.forecast, statusEl);
  return true;
}

// ── Share card canvas ───────────────────────────────────────
async function shareCard(canvas, payload, statusEl) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("share card could not be rendered");
  const file = new File([blob], "bowcast-story-card.png", { type: "image/png" });
  const plugins = window.Capacitor?.Plugins || {};

  if (STANDALONE && plugins.Share) {
    const options = {
      title: payload.title,
      text: payload.text,
      url: payload.url,
      dialogTitle: "Share your Bowcast story",
    };
    let cachePath = null;
    try {
      if (plugins.Filesystem) {
        cachePath = `bowcast-story-${Date.now()}.png`;
        const data = canvas.toDataURL("image/png").split(",")[1];
        const written = await plugins.Filesystem.writeFile({
          path: cachePath,
          data,
          directory: "CACHE",
        });
        if (written?.uri) options.files = [written.uri];
      }
      await plugins.Share.share(options);
      return;
    } finally {
      if (cachePath && plugins.Filesystem) {
        plugins.Filesystem.deleteFile({ path: cachePath, directory: "CACHE" }).catch(() => {});
      }
    }
  }

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: payload.title,
      text: payload.text,
      url: payload.url,
      files: [file],
    });
    return;
  }

  if (navigator.share) {
    await navigator.share({ title: payload.title, text: payload.text, url: payload.url });
    return;
  }

  const copied = `${payload.text}\n${payload.url}`;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(copied);
    if (statusEl) statusEl.textContent = "Share text and Bowcast link copied.";
    return;
  }
  throw new Error("sharing is unavailable on this device");
}

async function showShareCard(loc, forecastSnapshot, statusEl) {
  recordMetric("share_started");
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

  // Forecast value at the time, with honest units for fallback scores.
  const { hasEstimate, value, caption } = sightingShareValue(loc, forecastSnapshot);
  const payload = sightingSharePayload(loc, forecastSnapshot);
  ctx.fillStyle = "#5b48c2";
  ctx.font = `${hasEstimate ? 200 : 150}px 'Instrument Serif', Georgia, serif`;
  ctx.fillText(value, cx, 800);

  // Caption
  ctx.fillStyle = "#5d6675";
  ctx.font = "40px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText(caption, cx, 890);

  // Portable story details. These also accompany the image as native share
  // text and a Bowcast link, but remain visible if the target app keeps only
  // the card itself.
  ctx.fillStyle = "#5d6675";
  ctx.font = "32px 'Instrument Sans', system-ui, sans-serif";
  if (payload.interval) ctx.fillText(`Forecast interval · ${payload.interval}`, cx, 980);
  if (payload.look) ctx.fillText(`Look ${payload.look}`, cx, 1030);
  if (payload.issued) ctx.fillText(`Forecast issued ${payload.issued}`, cx, 1080);

  // Bottom branding
  ctx.fillStyle = "#232a35";
  ctx.font = "36px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText("bowcast · rainbow forecast", cx, 1240);
  ctx.fillText("bowcast.app", cx, 1290);

  // Pass the generated card and its structured link/text directly to the
  // platform share sheet. No manual image download is required.
  try {
    await shareCard(canvas, payload, statusEl);
  } catch (err) {
    const cancelled = err.name === "AbortError" || /cancel/i.test(err.message || "");
    if (!cancelled) console.warn("share card error:", err);
    if (statusEl && !cancelled) {
      statusEl.textContent = "Sharing is unavailable here. Open bowcast.app to share this forecast.";
    }
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
  const label = isProb ? `${val}%` : `${val}/100`;
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

// Notable rainbow places are a separate editorial layer, never a forecast
// value. Their field-guide labels stay visible while the user pans or zooms;
// the forecast gauges remain above them in Leaflet's regular marker pane.
function buildRainbowPlaceIcon(place, compact = false) {
  const html = `<div class="rainbow-place-marker${compact ? " rainbow-place-marker-compact" : ""}">
    <span class="rainbow-place-glyph" aria-hidden="true">
      <svg viewBox="0 0 28 22" width="28" height="22">
        <path d="M3 18 A11 11 0 0 1 25 18" fill="none" stroke="#7a68d9" stroke-width="2.5"/>
        <path d="M6.5 18 A7.5 7.5 0 0 1 21.5 18" fill="none" stroke="#2f9e8f" stroke-width="2.5"/>
        <path d="M10 18 A4 4 0 0 1 18 18" fill="none" stroke="#dd9f2e" stroke-width="2.5"/>
        <line x1="1" y1="18" x2="27" y2="18" stroke="#232a35" stroke-width="1.5"/>
      </svg>
    </span>
    <span class="rainbow-place-copy">
      <span class="rainbow-place-kind">${esc(place.rainbowPlace.label)}</span>
      <span class="rainbow-place-name">${esc(place.name)}</span>
    </span>
  </div>`;
  return L.divIcon({
    html,
    className: `rainbow-place-icon${compact ? " is-compact" : ""}`,
    iconSize: compact ? [42, 42] : [176, 46],
    iconAnchor: [16, 23],
    popupAnchor: [0, -22],
  });
}

function buildRainbowPlacePopup(place) {
  const location = [place.region, place.country].filter(Boolean).join(", ");
  return `<article class="rainbow-place-popup">
    <p class="rainbow-place-popup-kind">${esc(place.rainbowPlace.label)}</p>
    <h2>${esc(place.name)}</h2>
    <p class="rainbow-place-popup-location">${esc(location)}</p>
    <p class="rainbow-place-popup-summary">${esc(place.rainbowPlace.summary)}</p>
    <div class="rainbow-place-actions">
      <button class="rainbow-place-forecast" type="button" data-lat="${place.lat}" data-lon="${place.lon}" data-label="${esc(place.name)}">Forecast this place</button>
      <a href="../rainbow-forecast/${encodeURIComponent(place.slug)}.html">City guide</a>
    </div>
  </article>`;
}

// ── Legend control ──────────────────────────────────────────
function legendHtml(hasEstimate = true, peakLabel = "Today's peak") {
  if (!hasEstimate) {
    return `
      <h3>${peakLabel} Conditions score</h3>
      <div class="legend-row"><div class="legend-swatch swatch-high"></div><span class="legend-text">70-100 Strong</span></div>
      <div class="legend-row"><div class="legend-swatch swatch-good"></div><span class="legend-text">50-69 Good</span></div>
      <div class="legend-row"><div class="legend-swatch swatch-moderate"></div><span class="legend-text">25-49 Fair</span></div>
      <div class="legend-row"><div class="legend-swatch swatch-low"></div><span class="legend-text">1-24 Slim</span></div>
      <div class="legend-row"><div class="legend-swatch swatch-none"></div><span class="legend-text">0 Unlikely</span></div>`;
  }
  return `
    <h3>${peakLabel} Estimated chance</h3>
    <div class="legend-row"><div class="legend-swatch swatch-high"></div><span class="legend-text">45%+ Strong</span></div>
    <div class="legend-row"><div class="legend-swatch swatch-good"></div><span class="legend-text">25-44% Good</span></div>
    <div class="legend-row"><div class="legend-swatch swatch-moderate"></div><span class="legend-text">10-24% Fair</span></div>
    <div class="legend-row"><div class="legend-swatch swatch-low"></div><span class="legend-text">1-9% Slim</span></div>
    <div class="legend-row"><div class="legend-swatch swatch-none"></div><span class="legend-text">0% Unlikely</span></div>`;
}

function addLegend(map) {
  const Legend = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const div = L.DomUtil.create("div");
      div.id = "legend";
      div.innerHTML = legendHtml(true);
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  const control = new Legend();
  control.addTo(map);
  return control.getContainer();
}

function addRainbowPlacesControl(map, places) {
  const RainbowPlacesControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "rainbow-places-control");
      const button = L.DomUtil.create("button", "rainbow-places-button", container);
      button.type = "button";
      button.title = "Show notable rainbow places";
      button.setAttribute("aria-label", `Show ${places.length} notable rainbow places on the map`);
      button.innerHTML = `
        <svg class="rainbow-places-button-glyph" viewBox="0 0 28 22" width="25" height="20" aria-hidden="true">
          <path d="M3 18 A11 11 0 0 1 25 18" fill="none" stroke="#7a68d9" stroke-width="2.5"/>
          <path d="M6.5 18 A7.5 7.5 0 0 1 21.5 18" fill="none" stroke="#2f9e8f" stroke-width="2.5"/>
          <path d="M10 18 A4 4 0 0 1 18 18" fill="none" stroke="#dd9f2e" stroke-width="2.5"/>
          <line x1="1" y1="18" x2="27" y2="18" stroke="#232a35" stroke-width="1.5"/>
        </svg>
        <span>Rainbow places</span>
        <span class="rainbow-places-count" aria-hidden="true">${places.length}</span>`;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stop(event);
        const bounds = L.latLngBounds(places.map((place) => [place.lat, place.lon]));
        map.fitBounds(bounds, {
          paddingTopLeft: [72, 72],
          paddingBottomRight: [72, 104],
          maxZoom: 3,
          animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        });
      });
      return container;
    },
  });

  return new RainbowPlacesControl().addTo(map);
}

// ── Main init ───────────────────────────────────────────────
async function init() {
  // DOM refs
  const updatedText   = document.getElementById("updated-text");
  const refreshBtn    = document.getElementById("refresh-btn");
  const locateBtn     = document.getElementById("locate-btn");
  const searchBtn     = document.getElementById("search-btn");
  const notifyBtn     = document.getElementById("notify-btn");
  const moreBtn       = document.getElementById("more-btn");
  const secondaryControls = document.getElementById("secondary-controls");
  const errorBanner   = document.getElementById("error-banner");
  const errorMessage  = document.getElementById("error-message");
  const errorRetryBtn = document.getElementById("error-retry-btn");
  const errorCloseBtn = document.getElementById("error-close-btn");
  const loadingOverlay  = document.getElementById("loading-overlay");
  const loadingText     = document.getElementById("loading-text");
  const mapContainer    = document.getElementById("map-container");
  const outlookBanner   = document.getElementById("outlook-banner");
  const outlookText     = document.getElementById("outlook-text");
  const dayBar          = document.getElementById("day-bar");
  const locationPanel   = document.getElementById("location-panel");
  const locationHint    = document.getElementById("location-hint");
  const useGpsBtn       = document.getElementById("use-gps-btn");
  const previewDefaultBtn = document.getElementById("preview-default-btn");
  const locationSearch  = document.getElementById("location-search");
  const locationResults = document.getElementById("location-results");
  const alertPanel      = document.getElementById("alert-panel");
  const alertEnableBtn  = document.getElementById("alert-enable-btn");
  const alertCancelBtn  = document.getElementById("alert-cancel-btn");

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
  let suppressFitUntil = 0;
  let openTown = null;
  let hintShown = false;  // auto-open panel once per session on fallback location
  let fetchSeq = 0;

  function forecastFreshness() {
    const generatedMs = generatedAt ? new Date(generatedAt).getTime() : NaN;
    const stale = !Number.isFinite(generatedMs) || Date.now() - generatedMs > FORECAST_STALE_AFTER_MS;
    return { stale, offline: navigator.onLine === false };
  }

  const hasValidSavedLocation = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_LOCATION) || "null");
      return saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon);
    } catch (_) {
      return false;
    }
  };
  const params = new URLSearchParams(window.location.search);
  const urlLat = Number.parseFloat(params.get("lat"));
  const urlLon = Number.parseFloat(params.get("lon"));
  let firstRunChoice = !STANDALONE && localStorage.getItem(LS_LOCATION_CHOICE_SEEN) !== "1" &&
    !hasValidSavedLocation() &&
    !(Number.isFinite(urlLat) && Number.isFinite(urlLon) && Math.abs(urlLat) <= 90 && Math.abs(urlLon) <= 180);

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
    // On the web, render the safe default immediately and ask before requesting
    // location. Native apps can continue resolving an already granted location.
    if (!refresh && !STANDALONE) return DEFAULT_LOCATION;
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

  // Batched terrain elevation (one Open-Meteo call). The DEM reads 0 or below
  // over sea, strait, or ocean and the real height on land, which separates
  // coastal water from land without sending synthetic ring coordinates to a
  // reverse-geocoding service.
  async function elevationsFor(points) {
    try {
      const lat = points.map((p) => p.lat).join(',');
      const lon = points.map((p) => p.lon).join(',');
      const r = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`, {}, 6000);
      if (r.ok) return (await r.json()).elevation || null;
    } catch (_) { /* keep every point when elevation is unavailable */ }
    return null;
  }

  async function relevantPointsAround(lat, lon) {
    const pts = pointsAround(lat, lon);
    const elev = await elevationsFor(pts);
    if (!elev) return pts;
    const kept = [pts[0]]; // the user's own spot always stays, land or not
    pts.slice(1).forEach((p, i) => {
      if (elev[i + 1] > 0) kept.push(p);
    });
    return kept;
  }

  const roundCell = (x) => Math.round(x * 100) / 100; // ~1 km, so nearby users share the edge cache

  async function getLikelihood() {
    loadingText.textContent = "Choosing your forecast area…";
    currentLocation = await resolveLocation();
    const lat = roundCell(currentLocation.lat), lon = roundCell(currentLocation.lon);
    loadingText.textContent = "Loading the shared forecast and nearby land…";
    const keptPromise = relevantPointsAround(lat, lon);

    // Start the cached forecast and land lookup together. Keep only land points
    // after both finish, with the browser-safe core as the resilient fallback.
    if (!STANDALONE) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`/api/likelihood?lat=${lat}&lon=${lon}`, { signal: controller.signal })
          .finally(() => clearTimeout(timeout));
        const kept = await keptPromise;
        if (res.ok) {
          const data = await res.json();
          if (data.intervalSchemaVersion !== FORECAST_INTERVAL_SCHEMA_VERSION) {
            throw new Error("Shared forecast uses an old interval schema");
          }
          const label = new Map(kept.map((p) => [`${p.lat},${p.lon}`, p.name]));
          const locations = data.locations
            .filter((l) => label.has(`${l.lat},${l.lon}`))
            .map((l) => ({ ...l, name: label.get(`${l.lat},${l.lon}`) }));
          if (locations.length) return { ...data, locations };
        }
      } catch (_) { /* fall through to on-device compute */ }
    }
    loadingText.textContent = "Shared forecast unavailable. Checking on this device…";
    const kept = await keptPromise;
    return computeLikelihood(kept);
  }

  // ── Map setup ─────────────────────────────────────────────
  const map = L.map("map", {
    center: [48.45, -123.45],
    zoom: 11,
    zoomControl: true,
    worldCopyJump: true,
  });

  // CARTO Positron by day, Dark Matter at dusk: both pale and desaturated so
  // spectral color appears only where it means something (the gauges). The
  // basemap follows the site theme.
  const basemapUrl = (theme) =>
    `https://{s}.basemaps.cartocdn.com/${theme === "dark" ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
  const currentTheme = () =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const baseLayer = L.tileLayer(basemapUrl(currentTheme()), {
    maxZoom: 19,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Forecast data: <a href="https://open-meteo.com/">Open-Meteo</a>; estimates modified by Bowcast',
  }).addTo(map);
  document.addEventListener("bowcast-themechange", (e) => {
    baseLayer.setUrl(basemapUrl(e.detail?.theme));
  });

  // Keep editorial place labels below forecast gauges so the live answer is
  // always visually primary. The labels remain on the map as it is explored.
  map.createPane("rainbowPlaces");
  map.getPane("rainbowPlaces").style.zIndex = "450";
  const rainbowPlaceMarkers = RAINBOW_PLACES.map((place) => {
    const marker = L.marker([place.lat, place.lon], {
      icon: buildRainbowPlaceIcon(place, map.getZoom() >= 9),
      pane: "rainbowPlaces",
      title: `${place.name}, ${place.rainbowPlace.label}`,
      alt: `${place.name}, ${place.rainbowPlace.label}`,
      riseOnHover: true,
    });
    marker.bindPopup(buildRainbowPlacePopup(place), {
      maxWidth: 310,
      minWidth: 260,
      className: "rainbow-place-leaflet-popup",
    });
    marker.addTo(map);
    return { place, marker };
  });
  map.on("zoomend", () => {
    const compact = map.getZoom() >= 9;
    rainbowPlaceMarkers.forEach(({ place, marker }) => {
      marker.setIcon(buildRainbowPlaceIcon(place, compact));
    });
  });
  addRainbowPlacesControl(map, RAINBOW_PLACES);

  const legendEl = addLegend(map);

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
  function showLoading(on, message = "Loading the shared forecast…") {
    if (on) loadingText.textContent = message;
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

  // ── Persistent field card ─────────────────────────────────
  // Keep the strongest still-actionable answer visible above the map. The
  // whole-day peak remains available in markers and day tabs, while this card
  // never points someone toward an interval that has already ended.
  function updateOutlookBanner() {
    if (!lastLocations) { hideOutlook(); return; }

    const todayCandidates = lastLocations
      .filter((loc) => loc.nextPeak)
      .map((loc) => ({ ...loc.nextPeak, town: loc.name, dayIndex: 0 }));
    let target = selectBestForecast(todayCandidates);

    if (!target && lastOutlook?.dayIndex > 0) {
      const loc = lastLocations.find((candidate) => candidate.name === lastOutlook.town);
      const day = loc?.days?.[lastOutlook.dayIndex];
      target = day ? { ...day, town: loc.name, dayIndex: lastOutlook.dayIndex } : {
        ...lastOutlook,
        interval: lastOutlook.bestInterval || lastOutlook.bestHour,
      };
    }

    if (!target) {
      showOutlook("Not now: no rainbow setup in the next 7 days.", null, null);
      return;
    }

    const nowEpoch = Date.now() / 1000;
    const active = target.dayIndex === 0 &&
      Number.isFinite(target.intervalStartEpoch) && Number.isFinite(target.intervalEndEpoch) &&
      nowEpoch >= target.intervalStartEpoch && nowEpoch < target.intervalEndEpoch;
    const freshness = forecastFreshness();
    const prefix = freshness.offline
      ? "Offline saved forecast"
      : freshness.stale
        ? "Forecast may be stale"
        : active ? "Look now" : "Next window";
    const isEstimate = target.probability != null;
    const value = isEstimate
      ? `Estimated chance ${target.probability}%`
      : `Conditions score ${target.score}/100`;
    const interval = target.interval || target.bestInterval || target.bestHour;
    const weekday = target.dayIndex > 0 && target.weekday ? `${target.weekday}, ` : "";
    const intervalPart = interval ? ` · ${interval}` : "";
    const lookPart = target.bow?.look ? ` · face ${target.bow.look}` : "";
    const msg = `${prefix}: ${weekday}${target.town} · ${value}${intervalPart}${lookPart} →`;
    showOutlook(msg, target.dayIndex, target.town);
  }

  function showOutlook(msg, clickDay, clickTown) {
    outlookText.textContent = msg;
    outlookBanner.hidden = false;
    if (clickDay != null || clickTown) {
      outlookBanner.setAttribute("role", "button");
      outlookBanner.setAttribute("tabindex", "0");
      outlookBanner.setAttribute("aria-label", `${msg.replace(/ →$/, "")}. Open forecast details.`);
      outlookBanner.style.cursor = "pointer";
      outlookBanner._clickDay = clickDay;
      outlookBanner._clickTown = clickTown;
    } else {
      outlookBanner.removeAttribute("role");
      outlookBanner.removeAttribute("tabindex");
      outlookBanner.removeAttribute("aria-label");
      outlookBanner.style.cursor = "";
      outlookBanner._clickDay = null;
      outlookBanner._clickTown = null;
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
      const marker = markers.find((candidate) => candidate.options.title === outlookBanner._clickTown);
      if (marker) marker.openPopup();
    }
  });
  outlookBanner.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && outlookBanner._clickDay != null) {
      e.preventDefault();
      selectDay(outlookBanner._clickDay);
      const marker = markers.find((candidate) => candidate.options.title === outlookBanner._clickTown);
      if (marker) marker.openPopup();
    }
  });

  function tickUpdated() {
    if (!generatedAt) { updatedText.textContent = "-"; return; }
    // When the ensemble API is unavailable or rate-limited, the map falls back
    // to the deterministic quality score (0-100), not a probability. Flag it so
    // a bare "4" is not mistaken for a broken percentage (matches the Now page).
    const ensembleOn = Array.isArray(lastLocations) && lastLocations.some((l) => l.probability != null);
    const freshness = forecastFreshness();
    const update = freshness.offline
      ? `Offline · saved ${relativeTime(generatedAt)}`
      : freshness.stale
        ? `May be stale · updated ${relativeTime(generatedAt)}`
        : `Updated ${relativeTime(generatedAt)}`;
    updatedText.textContent = update + (ensembleOn ? "" : " · score only: ensemble unavailable");
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

    // The legend must describe what the badges on screen actually show, so it
    // keys off the same per-day value the markers use (estimated chance when
    // this day's ensemble is present, conditions score otherwise).
    legendEl.innerHTML = legendHtml(
      locations.some((loc) => (loc.days?.[dayIndex] ?? loc).probability != null),
      dayIndex === 0 ? "Today's peak" : "Selected-day peak",
    );

    const bounds = L.latLngBounds();

    locations.forEach(loc => {
      const icon = buildIcon(loc, dayIndex);
      const d = loc.days?.[dayIndex] ?? loc;
      const peakText = dayIndex === 0 ? "today's peak" : "selected-day peak";
      const valueText = d.probability != null
        ? `${peakText} estimated chance ${d.probability}%`
        : `${peakText} conditions score ${d.score}/100`;
      const dayText = d.weekday || (dayIndex === 0 ? "today" : `day ${dayIndex + 1}`);
      const markerLabel = `${loc.name}, ${dayText}, ${valueText}`;
      const marker = L.marker([loc.lat, loc.lon], {
        icon,
        title: loc.name,
        alt: markerLabel,
        forecastLocation: true,
      });

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

    dayBar.innerHTML = '<span class="day-bar-caption">Best nearby</span>';
    dayBar.hidden = false;

    for (let i = 0; i < numDays; i++) {
      // Estimated chances and Conditions scores are different scales. If any
      // nearby estimate exists, compare estimates only; otherwise use scores.
      const bestDay = selectBestForecast(locations.map((loc) => loc.days?.[i]));
      const hasProb = bestDay?.probability != null;
      const maxVal = hasProb ? bestDay.probability : bestDay?.score ?? 0;

      const level = hasProb ? probToLevel(maxVal) : scoreToLevel(maxVal);
      const valLabel = hasProb ? `${maxVal}%` : `${maxVal}/100`;

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
      btn.title = `${weekday || `Day ${i}`}: best nearby ${hasProb ? `estimated chance ${maxVal}%` : `conditions score ${maxVal}/100`}`;
      btn.setAttribute("aria-label", btn.title);

      // Today gets an indigo dot marker
      const dotHtml = (i === 0)
        ? `<span class="day-tab-today-dot" aria-hidden="true"></span>`
        : "";

      btn.innerHTML = `${dotHtml}<span class="day-tab-weekday">${esc(weekdayShort)}</span><span class="day-tab-val" style="color:var(--text-${level})">${esc(valLabel)}</span>`;

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
    if (e.popup._source?.options?.forecastLocation) recordMetric("window_opened");
    const popupEl = e.popup.getElement();
    if (!popupEl) return;
    const placeForecastBtn = popupEl.querySelector(".rainbow-place-forecast");
    if (placeForecastBtn) {
      placeForecastBtn.addEventListener("click", () => {
        const placeLocation = {
          lat: parseFloat(placeForecastBtn.dataset.lat),
          lon: parseFloat(placeForecastBtn.dataset.lon),
          label: placeForecastBtn.dataset.label,
        };
        localStorage.setItem(LS_LOCATION, JSON.stringify(placeLocation));
        currentLocation = placeLocation;
        selectedDay = 0;
        userMoved = false;
        map.closePopup();
        fetchData();
      });
    }
    popupEl.querySelectorAll(".day-chip[data-day]").forEach(chip => {
      chip.addEventListener("click", () => {
        const idx = parseInt(chip.dataset.day, 10);
        if (!isNaN(idx)) selectDay(idx);
      });
    });
    const sightingButtons = [...popupEl.querySelectorAll(".sight-btn[data-outcome]")];
    const sightingStatus = popupEl.querySelector(".sighting-status");
    sightingButtons.forEach((sightBtn) => {
      sightBtn.addEventListener("click", () => {
        if (sightBtn.disabled) return;
        sightingButtons.forEach((button) => { button.disabled = true; });
        const name = sightBtn.dataset.loc;
        const loc = lastLocations && lastLocations.find(l => l.name === name);
        if (loc && sightingStatus) {
          const saved = recordSighting(loc, sightBtn.dataset.outcome, generatedAt, sightingStatus);
          if (!saved) sightingButtons.forEach((button) => { button.disabled = false; });
        }
      });
    });
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
    const seq = ++fetchSeq;
    showLoading(true);
    hideError();

    try {
      const data = await getLikelihood();
      if (seq !== fetchSeq) return;

      generatedAt = data.generatedAt || null;
      lastData = data;

      if (Array.isArray(data.locations)) {
        lastLocations = data.locations;
        lastOutlook = data.outlook || null;

        // Clamp selectedDay to available days
        const numDays = (lastLocations[0]?.days || []).length;
        if (numDays > 0) {
          selectedDay = Math.max(0, Math.min(selectedDay, numDays - 1));
        }

        buildDayBar(lastLocations);
        renderLocations(lastLocations, selectedDay, { fit: true });
        updateOutlookBanner();
        recordMetric("forecast_loaded");
      }

      // After lastLocations is current, so the "conditions scores" suffix
      // describes this fetch, not the previous one.
      startUpdatedTicker();

      checkNotify(data);

      // Auto-open the location panel once per session when on fallback location
      if (!hintShown && currentLocation && currentLocation.fallback) {
        hintShown = true;
        openLocationPanel(false); // no focus: don't pop the keyboard on load
      }
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.error("Failed to fetch rainbow data:", err);
      showError(`Couldn't load data: ${err.message}. Check your connection.`);
      updatedText.textContent = "Failed to load";
    } finally {
      if (seq !== fetchSeq) return;
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
        notifyBtn.setAttribute("aria-label", "Rainbow push alerts on. Turn off alerts");
        notifyBtn.setAttribute("aria-pressed", "true");
        notifyBtn.className = "notify-on";
      } else {
        notifyBtn.title = "Get push alerts when any town's estimated chance reaches 25%";
        notifyBtn.setAttribute("aria-label", "Enable rainbow push alerts at 25% estimated chance");
        notifyBtn.setAttribute("aria-pressed", "false");
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
      notifyBtn.setAttribute("aria-label", "Rainbow alerts blocked in browser settings");
      notifyBtn.setAttribute("aria-pressed", "false");
      notifyBtn.className = "notify-off";
      return;
    }
    if (notifyEnabled()) {
      notifyBtn.disabled = false;
      notifyBtn.title = "Rainbow alerts on (25%+). Click to turn off";
      notifyBtn.setAttribute("aria-label", "Rainbow alerts on while this tab is open. Turn off alerts");
      notifyBtn.setAttribute("aria-pressed", "true");
      notifyBtn.className = "notify-on";
    } else {
      notifyBtn.disabled = false;
      notifyBtn.title = "Get alerts at 25% estimated chance while this tab is open";
      notifyBtn.setAttribute("aria-label", "Enable rainbow alerts at 25% estimated chance while this tab is open");
      notifyBtn.setAttribute("aria-pressed", "false");
      notifyBtn.className = "notify-off";
    }
  }

  function checkNotify(data) {
    if (STANDALONE) return;
    if (!notifyEnabled() || !data) return;
    const freshness = forecastFreshness();
    if (freshness.offline || freshness.stale) return;

    const today = new Date().toDateString();

    // Load and prune old notified keys (keep only today's entries)
    let notified = {};
    try { notified = JSON.parse(localStorage.getItem(LS_NOTIFIED) || "{}"); } catch (_) {}
    Object.keys(notified).forEach(k => {
      if (!k.includes(`|${today}|`)) delete notified[k];
    });

    // Key includes the ~25 km cell so moving to a new city never suppresses
    // alerts deduped under the same relative name ("12 km NE") elsewhere.
    const dedupeKey = (l) => {
      const start = l.nextPeak?.intervalStartEpoch ?? l.bestIntervalStartEpoch ?? l.bestEpoch;
      const end = l.nextPeak?.intervalEndEpoch ?? l.bestIntervalEndEpoch ?? "";
      return `${cellKey(l.lat, l.lon)}|${l.name}|${today}|${start}|${end}`;
    };

    // Only alert while the peak interval is active or still ahead; a peak
    // that has already ended is history, not an alert. Threshold on the
    // still-actionable nextPeak when present, else the whole-day probability.
    const actionableP = (l) => (l.nextPeak?.probability ?? l.probability) ?? 0;
    const qualifying = data.locations.filter(l =>
      actionableP(l) >= NOTIFY_THRESHOLD && alertEligible(l));
    const unnotified = qualifying.filter(l => !notified[dedupeKey(l)]);

    if (unnotified.length > 0) {
      // Lead with the strongest spot in the shared alert voice; the rest
      // fold into a count instead of a wall of lines.
      const top = unnotified.reduce((a, b) => (actionableP(b) > actionableP(a) ? b : a));
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
        recordMetric("alert_enabled");
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

  function closeAlertPanel() {
    alertPanel.hidden = true;
  }

  function openAlertPanel() {
    closeLocationPanel();
    alertPanel.hidden = false;
    alertEnableBtn.focus();
  }

  async function enableBrowserAlerts() {
    closeAlertPanel();
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem(LS_NOTIFY_ENABLED, "1");
      recordMetric("alert_enabled");
      updateNotifyBtn();
      new Notification("Bowcast website alerts on", {
        body: "Keep this map tab open. Bowcast will alert at a 25% or higher Estimated chance; Conditions scores do not trigger alerts.",
      });
      checkNotify(lastData);
    } else {
      updateNotifyBtn();
    }
  }

  notifyBtn.addEventListener("click", async () => {
    if (STANDALONE) { await togglePush(); return; }
    if (notifyEnabled()) {
      localStorage.removeItem(LS_NOTIFY_ENABLED);
      updateNotifyBtn();
      return;
    }
    openAlertPanel();
  });

  alertEnableBtn.addEventListener("click", enableBrowserAlerts);
  alertCancelBtn.addEventListener("click", closeAlertPanel);

  // ── Location panel ────────────────────────────────────────
  function openLocationPanel(focusSearch = true) {
    closeAlertPanel();
    locationSearch.value = "";
    locationResults.innerHTML = "";
    // The in-panel GPS retry only appears in the fallback/denied flow; the
    // header target button is the everyday "use my location" control.
    locationHint.hidden = !(firstRunChoice || (currentLocation && currentLocation.fallback));
    useGpsBtn.hidden = locationHint.hidden;
    previewDefaultBtn.hidden = !firstRunChoice;
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
        localStorage.setItem(LS_LOCATION_CHOICE_SEEN, "1");
        firstRunChoice = false;
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
        const resp = await fetchWithTimeout(
          "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(q) + "&count=5&language=en&format=json",
          {},
          8000,
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
        localStorage.setItem(LS_LOCATION_CHOICE_SEEN, "1");
        firstRunChoice = false;
        userMoved = false;
        closeLocationPanel();
        fetchData();
      }
    }
  });

  useGpsBtn.addEventListener("click", async () => {
    localStorage.setItem(LS_LOCATION_CHOICE_SEEN, "1");
    firstRunChoice = false;
    localStorage.removeItem(LS_LOCATION);
    userMoved = false;
    closeLocationPanel();
    showLoading(true, "Requesting your location…");
    currentLocation = await resolveLocation({ refresh: true });
    fetchData();
  });

  previewDefaultBtn.addEventListener("click", () => {
    localStorage.setItem(LS_LOCATION_CHOICE_SEEN, "1");
    firstRunChoice = false;
    closeLocationPanel();
  });

  // Close panel when clicking outside it or #locate-btn
  document.addEventListener("click", (e) => {
    if (locationPanel.hidden) return;
    if (locationPanel.contains(e.target) || searchBtn.contains(e.target)) return;
    closeLocationPanel();
  });

  document.addEventListener("click", (e) => {
    if (alertPanel.hidden) return;
    if (alertPanel.contains(e.target) || notifyBtn.contains(e.target)) return;
    closeAlertPanel();
  });

  // ── Event listeners ───────────────────────────────────────
  // Target button = use my location directly (same action as the panel's
  // GPS retry). Magnifier button = the search panel.
  locateBtn.addEventListener("click", async () => {
    localStorage.setItem(LS_LOCATION_CHOICE_SEEN, "1");
    firstRunChoice = false;
    localStorage.removeItem(LS_LOCATION);
    userMoved = false;
    closeLocationPanel();
    showLoading(true, "Requesting your location…");
    currentLocation = await resolveLocation({ refresh: true });
    fetchData();
  });

  searchBtn.addEventListener("click", () => {
    toggleLocationPanel();
  });

  const closeMoreControls = () => {
    secondaryControls.removeAttribute("data-open");
    moreBtn.setAttribute("aria-expanded", "false");
  };

  moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = secondaryControls.dataset.open !== "true";
    secondaryControls.toggleAttribute("data-open", open);
    if (open) secondaryControls.dataset.open = "true";
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", (event) => {
    if (secondaryControls.dataset.open !== "true") return;
    if (secondaryControls.contains(event.target) || moreBtn.contains(event.target)) return;
    closeMoreControls();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMoreControls();
      closeAlertPanel();
    }
  });

  refreshBtn.addEventListener("click", fetchData);

  errorRetryBtn.addEventListener("click", fetchData);

  errorCloseBtn.addEventListener("click", () => {
    hideError();
  });

  // ── Kick off ──────────────────────────────────────────────
  updateNotifyBtn();
  initPushListeners();
  if (PUSH_CAPABLE && localStorage.getItem(LS_PUSH_ENABLED) === "1") {
    // Refresh the platform token and registered area on startup. This keeps
    // long-lived alert registrations current and naturally repairs token
    // rotation performed by APNs or FCM.
    PushPlugin.register().catch((error) => console.warn("push refresh failed:", error.message));
  }
  if (firstRunChoice) {
    hintShown = true;
    openLocationPanel(false);
  }
  await fetchData();

  const refreshFreshnessCopy = () => {
    tickUpdated();
    updateOutlookBanner();
  };
  window.addEventListener("online", refreshFreshnessCopy);
  window.addEventListener("offline", refreshFreshnessCopy);
}

// ── Bootstrap ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initThemeToggles();
  flushSightingOutbox();
  init().catch(err => console.error("Init error:", err));
});

window.addEventListener("online", () => flushSightingOutbox());
