/**
 * Worldwide current-interval board. The hosted page prefers Bowcast's shared
 * ten-minute API cache, then falls back to the browser-safe forecast core.
 */
import { rankNow } from '../core/now.js';
import { confirmHappeningNow, radarEvidencePhrase } from '../core/liveConfirm.js';
import { CITIES } from '../core/cities.js';
import { FORECAST_INTERVAL_SCHEMA_VERSION } from '../core/forecast-time.js';
import { initThemeToggles } from '../theme.js';

const PROB_BANDS = [[45, 'high', 'Strong'], [25, 'good', 'Good'], [10, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
const SCORE_BANDS = [[70, 'high', 'Strong'], [50, 'good', 'Good'], [25, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
const classify = (v, isEstimate) => (isEstimate ? PROB_BANDS : SCORE_BANDS).find((b) => v >= b[0]);

const statusEl = document.getElementById('now-status');
const happeningEl = document.getElementById('happening');
const hotEl = document.getElementById('hot');
const mainEl = document.getElementById('now-main');
const listEl = document.getElementById('now-list');
const showAllBtn = document.getElementById('now-show-all');
const updatedEl = document.getElementById('now-updated');
const cityCountEl = document.getElementById('city-count');
const rankingTitleEl = document.getElementById('now-ranking-title');
cityCountEl.textContent = CITIES.length;

let webcams = {};
let currentResult = null;
let liveSlugs = new Set();
let showAll = false;
let hasRendered = false;
const NOW_SNAPSHOT_KEY = 'bowcast-now-snapshot-v2';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const valText = (c) => c.nowIsProb ? `${Math.round(c.headline)}%` : `${Math.round(c.headline)}/100`;

const SUN = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" style="vertical-align:-1px;margin-right:3px"><circle cx="8" cy="8" r="3" fill="#e0922e"/><g stroke="#e0922e" stroke-width="1.3" stroke-linecap="round"><path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/></g></svg>';
const MOON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" style="vertical-align:-1px;margin-right:3px"><path d="M11.2 2.7A5.6 5.6 0 1 0 14 11a6.2 6.2 0 0 1-2.8-8.3z" fill="#9aa2b1"/></svg>';

function subtitle(c) {
  const place = [c.region, c.country].filter(Boolean).join(', ');
  const text = place ? `${place} · ${c.localTime} local` : `${c.localTime} local`;
  return `${c.isDay ? SUN : MOON}${esc(text)}`;
}

function peakText(c) {
  if (!c.peakHour) return '';
  if (c.peakProb != null) return `Peak estimated chance ${c.peakProb}% during ${esc(c.peakInterval || c.peakHour)}`;
  return `Peak conditions score ${c.peakScore ?? 0}/100 during ${esc(c.peakInterval || c.peakHour)}`;
}

const intervalText = (c) => c.nowInterval ? `This hour: ${esc(c.nowInterval)}` : 'This hour';

function row(c, i) {
  const [, level, word] = classify(c.headline, c.nowIsProb);
  const barValue = Math.max(0, Math.min(100, Math.round(c.headline)));
  const valueKind = c.nowIsProb ? `${intervalText(c)}. Estimated chance: ${valText(c)}` : `${intervalText(c)}. Conditions score: ${valText(c)}`;
  const visibleKind = c.nowIsProb ? `This hour · ${word}` : `This-hour score · ${word}`;
  return `<li><a class="now-row" href="../rainbow-forecast/${esc(c.slug)}.html" aria-label="${esc(`${i + 1}. ${c.name}. ${valueKind}. ${peakText(c)}`)}">
    <span class="now-rank" aria-hidden="true">${i + 1}</span>
    <span class="now-city">
      <span class="now-name">${esc(c.name)}</span>
      <span class="now-sub">${subtitle(c)}</span>
      <span class="now-bar" aria-hidden="true"><span class="bg-${level}" style="width:${barValue}%"></span></span>
      <span class="now-peak">${intervalText(c)} · ${peakText(c)}</span>
    </span>
    <span class="now-right">
      <span class="now-num lv-${level}">${valText(c)}</span>
      <span class="now-word lv-${level}">${esc(visibleKind)}</span>
    </span>
  </a></li>`;
}

function camHtml(c) {
  const w = webcams[c.slug];
  if (!w?.id) return '';
  return `<div class="hot-cam"><iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade"
      src="https://webcams.windy.com/webcams/public/embed/player/${encodeURIComponent(w.id)}/day"
      title="Live webcam near ${esc(c.name)}"></iframe></div>
    <div class="hot-cam-credit">Nearby webcam: ${esc(w.title || 'view')} · Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener">windy.com</a> - <a href="https://www.windy.com/webcams/add" target="_blank" rel="noopener">add new webcam</a> · <a href="https://www.windy.com/webcams/${encodeURIComponent(w.id)}" target="_blank" rel="noopener">open webcam ↗</a></div>`;
}

function hotCard(c, eyebrow) {
  const [, level, word] = classify(c.headline, c.nowIsProb);
  const valueKind = c.nowIsProb ? `${intervalText(c)} estimated chance` : `${intervalText(c)} conditions score`;
  return `<article class="hot-card">
    ${camHtml(c)}
    <div class="hot-body">
      <p class="hot-eyebrow">${esc(eyebrow)}</p>
      <div class="hot-title">
        <h3 class="hot-name">${esc(c.name)}</h3>
        <span class="hot-num lv-${level}">${valText(c)}</span>
        <span class="hot-word lv-${level}">${esc(c.nowIsProb ? `This hour · ${word}` : `This-hour score · ${word}`)}</span>
      </div>
      <p class="hot-meta">${subtitle(c)} · ${valueKind}. ${peakText(c)}</p>
      <div class="hot-links">
        <a href="../rainbow-forecast/${esc(c.slug)}.html">Full forecast →</a>
        <a href="../map/?lat=${c.lat}&lon=${c.lon}&label=${encodeURIComponent(c.name)}">Open on map →</a>
      </div>
    </div>
  </article>`;
}

function renderHot(cities) {
  const available = cities.filter((c) => !liveSlugs.has(c.slug));
  const strong = available.filter((c) => c.nowIsProb ? c.headline >= 45 : c.headline >= 70);
  const leaders = strong.length ? strong.slice(0, 2) : available.slice(0, 1);
  if (!leaders.length || leaders[0].headline <= 0) {
    hotEl.hidden = true;
    hotEl.innerHTML = '';
    return;
  }
  hotEl.innerHTML = `<h2 class="now-section-label">Forecast leaders this hour</h2>` +
    leaders.map((c) => hotCard(c, c.nowIsProb ? 'Highest estimated chance this hour' : 'Strongest forecast pattern this hour')).join('');
  hotEl.hidden = false;
}

function renderList(cities) {
  const visible = showAll ? cities : cities.slice(0, 20);
  listEl.innerHTML = visible.map(row).join('');
  showAllBtn.hidden = cities.length <= 20;
  showAllBtn.textContent = showAll ? 'Show top 20' : `Show all ${cities.length}`;
  showAllBtn.setAttribute('aria-expanded', showAll ? 'true' : 'false');
}

function render(result, { saved = false } = {}) {
  currentResult = result;
  statusEl.classList.remove('error', 'saved');
  cityCountEl.textContent = result.cities.length;
  if (saved) {
    hotEl.hidden = true;
    hotEl.innerHTML = '';
    happeningEl.hidden = true;
    happeningEl.innerHTML = '';
  } else {
    renderHot(result.cities);
  }
  renderList(result.cities);
  mainEl.hidden = false;
  statusEl.hidden = true;
  rankingTitleEl.textContent = saved ? 'Saved worldwide ranking' : 'Ranked by this hour';

  const updated = new Date(result.generatedAt || Date.now());
  const time = updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const coverage = result.coverage;
  const partial = coverage && !coverage.complete ? ` · ${coverage.returned}/${coverage.requested} cities available` : '';
  const hasScores = result.cities.some((city) => !city.nowIsProb);
  updatedEl.textContent = `${saved ? 'Saved forecast from' : 'Updated'} ${time}`
    + (hasScores ? ' · /100 scores: ensemble unavailable there' : '') + partial;
}

function liveCard(r) {
  const c = r.city;
  const observed = r.tier === 'confirmed';
  const phaseUncertain = r.liquidPhaseSupported === false;
  const state = observed
    ? 'Observed ingredients aligned'
    : phaseUncertain && r.sunSource === 'satellite'
      ? 'Observed signals, precipitation phase uncertain'
      : 'Forecast-supported conditions';
  const rainPhrase = radarEvidencePhrase(r);
  const sunPhrase = r.sunSource === 'satellite'
    ? 'sun observed by satellite'
    : 'sunlight still supported by the forecast';
  return `<article class="live-card tier-${r.tier}">
    <p class="live-eyebrow">${state}</p>
    <h3 class="live-title">${esc(c.name)}</h3>
    <p class="live-detail"><b>Look ${esc(r.look)}.</b> Radar shows ${esc(rainPhrase)}; ${sunPhrase}, with the sun ${r.sunElevation}&deg; above the horizon. These ingredients do not confirm that a rainbow is visible.</p>
    <div class="live-links">
      <a href="../map/?lat=${c.lat}&lon=${c.lon}&label=${encodeURIComponent(c.name)}">Open on map →</a>
      <a href="../rainbow-forecast/${esc(c.slug)}.html">Full forecast →</a>
      <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">Weather data by RainViewer ↗</a>
    </div>
  </article>`;
}

async function renderHappening(cities) {
  try {
    const live = await confirmHappeningNow(cities);
    liveSlugs = new Set(live.map((r) => r.city.slug));
    if (live.length) {
      happeningEl.innerHTML = `<h2 class="now-section-label">Conditions aligned now</h2>` + live.slice(0, 4).map(liveCard).join('');
      happeningEl.hidden = false;
    } else {
      happeningEl.hidden = true;
      happeningEl.innerHTML = '';
    }
    if (currentResult) renderHot(currentResult.cities);
  } catch (err) {
    console.warn('live conditions check failed:', err);
    happeningEl.hidden = true;
  }
}

async function fetchSharedRanking() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('../api/now', { signal: controller.signal });
    if (!response.ok) throw new Error('shared forecast unavailable');
    const result = await response.json();
    if (!Array.isArray(result.cities) || result.cities.length === 0) throw new Error('shared forecast incomplete');
    if (result.intervalSchemaVersion !== FORECAST_INTERVAL_SCHEMA_VERSION) throw new Error('shared forecast uses an old interval schema');
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function refresh() {
  if (!hasRendered) {
    statusEl.textContent = 'Loading the shared worldwide forecast…';
    statusEl.hidden = false;
  }
  try {
    let result;
    try {
      result = await fetchSharedRanking();
    } catch (apiError) {
      if (!hasRendered) statusEl.textContent = 'Shared forecast is slow. Checking cities on this device…';
      result = await rankNow(CITIES, {});
    }
    render(result);
    hasRendered = true;
    try { localStorage.setItem(NOW_SNAPSHOT_KEY, JSON.stringify(result)); } catch (_) {}
    renderHappening(result.cities);
  } catch (err) {
    console.error('now page refresh failed:', err);
    if (!hasRendered) {
      try {
        const cached = JSON.parse(localStorage.getItem(NOW_SNAPSHOT_KEY) || 'null');
        if (cached?.intervalSchemaVersion === FORECAST_INTERVAL_SCHEMA_VERSION && cached?.cities?.length) {
          render(cached, { saved: true });
          hasRendered = true;
          statusEl.textContent = navigator.onLine
            ? 'A fresh worldwide forecast is unavailable. This saved ranking may be stale and is not a live observation.'
            : 'Offline. This saved ranking may be stale and is not a live observation.';
          statusEl.classList.add('saved');
          statusEl.hidden = false;
          return;
        }
      } catch (_) {}
      statusEl.textContent = 'Could not load the worldwide forecast. Check your connection and try again.';
      statusEl.classList.add('error');
    }
  }
}

showAllBtn.addEventListener('click', () => {
  showAll = !showAll;
  if (currentResult) renderList(currentResult.cities);
});

async function init() {
  initThemeToggles();
  webcams = await fetch('webcams.json').then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  await refresh();
  setInterval(refresh, 10 * 60 * 1000);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) refresh();
  });
}

init();
