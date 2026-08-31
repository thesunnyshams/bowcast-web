/**
 * Worldwide current-interval board. The hosted page prefers Bowcast's shared
 * ten-minute API cache, then falls back to the browser-safe forecast core.
 */
import { rankNow } from '../core/now.js';
import { sunElevationDeg } from '../core/solar.js';
import { confirmHappeningNow, radarEvidencePhrase } from '../core/liveConfirm.js';
import { CITIES } from '../core/cities.js';
import { FORECAST_INTERVAL_SCHEMA_VERSION } from '../core/forecast-time.js';
import { initThemeToggles } from '../theme.js';
import { fetchWithTimeout } from '../core/http.js';
import { sunDiagram, compassDiagram } from '../diagrams.js';

const PROB_BANDS = [[45, 'high', 'Strong'], [25, 'good', 'Good'], [10, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
const SCORE_BANDS = [[70, 'high', 'Strong'], [50, 'good', 'Good'], [25, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
// Interpolate {token} placeholders. What is left of the old dictionary layer:
// the strings themselves live inline now.
const fill = (text, vars) => (vars
  ? String(text).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m))
  : text);

const classify = (v, isEstimate) => (isEstimate ? PROB_BANDS : SCORE_BANDS).find((b) => v >= b[0]);

const statusEl = document.getElementById('now-status');
const retryBtn = document.getElementById('now-retry-btn');
const happeningEl = document.getElementById('happening');
const hotEl = document.getElementById('hot');
const mainEl = document.getElementById('now-main');
const listEl = document.getElementById('now-list');
const showAllBtn = document.getElementById('now-show-all');
const updatedEl = document.getElementById('now-updated');
const watchStateEl = document.getElementById('watch-state');
const watchLabelEl = document.getElementById('watch-label');
const watchStampEl = document.getElementById('watch-stamp');
const watchEmptyEl = document.getElementById('watch-empty');
const watchLastEl = document.getElementById('watch-last');
// Written here rather than hardcoded in the markup, so the count cannot drift
// from public/core/cities.js.
const cityCountEl = document.getElementById('city-count');
if (cityCountEl) cityCountEl.textContent = CITIES.length;

let webcams = {};
let currentResult = null;
let lastRenderSaved = false;
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

// The 42 degree ceiling, which is the whole reason the geometry column exists.
const BOW_CEILING_DEG = 42;
const SUN_BAR_MAX_DEG = 70;

// Chance is only half the physics. A bow is impossible with the sun below the
// horizon or above 42 degrees, whatever the rain does, so the board says so
// instead of letting a high chance imply a visible bow.
function geometryOf(elev) {
  if (elev == null) return { verdict: null, ruledOut: false };
  if (elev <= 0) return { verdict: fill('sun below horizon'), ruledOut: true };
  if (elev > BOW_CEILING_DEG) return { verdict: fill('sun above 42\u00B0'), ruledOut: true };
  return { verdict: fill('in the window'), ruledOut: false };
}

// sunElevation arrives with the ranking, but a cached API response or the saved
// localStorage snapshot can predate that field. Rather than leave the geometry
// column blank, fall back to computing it here from the coordinates the payload
// always carries, using the same shared solar code the ranking uses.
function sunElevationFor(c) {
  if (typeof c.sunElevation === 'number') return c.sunElevation;
  if (typeof c.lat !== 'number' || typeof c.lon !== 'number') return null;
  return Math.round(sunElevationDeg(new Date(), c.lat, c.lon));
}

function row(c, i) {
  const [, level, word] = classify(c.headline, c.nowIsProb);
  const place = [c.region, c.country].filter(Boolean).join(', ');
  const elev = sunElevationFor(c);
  const { verdict, ruledOut } = geometryOf(elev);
  const barPct = elev == null
    ? 0
    : Math.max(0, Math.min(100, (elev / SUN_BAR_MAX_DEG) * 100));
  const degLabel = elev == null ? '' : elev <= 0 ? fill('set') : `${elev}\u00B0`;
  // The day/night dot follows the same elevation the geometry column reports.
  // Taking it from the payload's isDay let the two contradict each other when
  // the response was cached across sunset.
  const isDay = elev != null ? elev > 0 : c.isDay;
  const valueKind = c.nowIsProb
    ? `${intervalText(c)}. Estimated chance: ${valText(c)}`
    : `${intervalText(c)}. Conditions score: ${valText(c)}`;
  const ariaGeo = verdict ? `. ${verdict}` : '';

  return `<li><a class="board-row${ruledOut ? ' ruled-out' : ''}" href="../rainbow-forecast/${esc(c.slug)}.html"
      aria-label="${esc(`${i + 1}. ${c.name}. ${valueKind}${ariaGeo}. ${peakText(c)}`)}">
    <span class="board-rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
    <span class="board-place">
      <span class="board-name">${esc(c.name)}</span>
      <span class="board-where">${esc(place)}</span>
    </span>
    <span class="board-local">
      <span class="dot" style="background:${isDay ? 'var(--amber)' : 'var(--line)'}"></span>${esc(c.localTime)}
    </span>
    <span class="board-sun">
      <span class="sun-bar" aria-hidden="true">
        <span class="ceiling"></span>
        <span class="fill" style="width:${barPct.toFixed(1)}%;background:${ruledOut ? 'var(--line)' : 'var(--teal)'}"></span>
      </span>
      <span class="deg">${esc(degLabel)}</span>
    </span>
    <span class="board-geo" style="color:${ruledOut ? 'var(--muted)' : 'var(--text-moderate)'}">${esc(verdict || '')}</span>
    <span class="board-read">
      <span class="board-value lv-${level}">${esc(valText(c))}</span>
      <span class="board-word lv-${level}">${esc(word.toLowerCase())}</span>
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
  showAllBtn.textContent = showAll
    ? fill('Show top 20', { n: 20 })
    : fill(`Show all ${cities.length}`, { count: cities.length });
  showAllBtn.setAttribute('aria-expanded', showAll ? 'true' : 'false');
}

function render(result, { saved = false } = {}) {
  currentResult = result;
  lastRenderSaved = saved;
  statusEl.classList.remove('error', 'saved');
  if (cityCountEl) cityCountEl.textContent = result.cities.length;
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

  const updated = new Date(result.generatedAt || Date.now());
  const time = updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const coverage = result.coverage;
  const partial = coverage && !coverage.complete ? ` · ${coverage.returned}/${coverage.requested} cities available` : '';
  const hasScores = result.cities.some((city) => !city.nowIsProb);
  updatedEl.textContent = `${saved ? 'Saved forecast from' : 'Updated'} ${time}`
    + (hasScores ? ' · /100 scores: ensemble unavailable there' : '') + partial;
}

// A watch-band entry draws its evidence rather than stating it: the sun as a
// real angle with a filled wedge and its arc, the 42 degree ceiling as a dashed
// reference ray with the degree label in the gap above it, and the look
// direction as a compass tick rotated to the bearing.
const COMPASS_DEG = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
const NAMED_BEARING = {
  north: 0, northeast: 45, east: 90, southeast: 135,
  south: 180, southwest: 225, west: 270, northwest: 315,
  'north-northeast': 22.5, 'east-northeast': 67.5, 'east-southeast': 112.5,
  'south-southeast': 157.5, 'south-southwest': 202.5, 'west-southwest': 247.5,
  'west-northwest': 292.5, 'north-northwest': 337.5,
};
function bearingOf(look) {
  const key = String(look ?? '').trim();
  if (COMPASS_DEG[key.toUpperCase()] != null) return COMPASS_DEG[key.toUpperCase()];
  const named = NAMED_BEARING[key.toLowerCase().replace(/\s+/g, '-')];
  return named != null ? named : null;
}

function liveCard(r) {
  const c = r.city;
  const [, level, word] = classify(c.headline ?? 0, c.nowIsProb);
  const rainPhrase = radarEvidencePhrase(r);
  const sunPhrase = r.sunSource === 'satellite'
    ? Number.isFinite(r.sky?.ageMin)
      ? fill('Satellite preceding-hour mean, {age} min old.', { age: r.sky.ageMin })
      : fill('Latest accepted satellite preceding-hour mean.')
    : fill('Sunlight still supported by the forecast.');
  const radarPhrase = Number.isFinite(r.radar?.ageMin)
    ? `${rainPhrase}. Radar frame ${r.radar.ageMin} min old.`
    : rainPhrase;
  const place = [c.region, c.country].filter(Boolean).join(', ');
  const bearing = bearingOf(r.look);

  return `<div class="watch-cell">
    <div class="watch-top">
      <div style="min-width:0">
        <h2 class="watch-name">${esc(c.name)}</h2>
        <p class="watch-where">${esc(place ? `${place} · ${c.localTime} local` : `${c.localTime} local`)}</p>
      </div>
      <div class="watch-read">
        <div class="watch-value lv-${level}">${esc(valText(c))}</div>
        <div class="watch-word lv-${level}">${esc(word.toLowerCase())}</div>
      </div>
    </div>
    <p class="watch-kind">${esc(c.nowIsProb ? fill('Estimated chance') : fill('Conditions score'))}</p>

    <div class="watch-fact">
      ${sunDiagram(r.sunElevation)}
      <div style="min-width:0">
        <div class="watch-fact-k">${esc(fill('Sun'))}</div>
        <p class="watch-fact-v">${esc(`${r.sunElevation}\u00B0 above the horizon.`)} ${esc(sunPhrase)}</p>
      </div>
    </div>

    ${bearing != null ? `<div class="watch-fact">
      ${compassDiagram(bearing)}
      <div style="min-width:0">
        <div class="watch-fact-k">${esc(fill('Look'))}</div>
        <div class="watch-fact-v big">${esc(r.look)}</div>
      </div>
    </div>` : ''}

    <div class="watch-block">
      <div class="watch-fact-k">${esc(fill('Radar'))}</div>
      <p class="watch-fact-v" style="max-width:42ch">${esc(radarPhrase)}</p>
    </div>

    <div class="watch-links">
      <a href="../map/?lat=${c.lat}&lon=${c.lon}&label=${encodeURIComponent(c.name)}">${esc(fill('Open on map'))} &rarr;</a>
      <a href="../rainbow-forecast/${esc(c.slug)}.html">${esc(fill('Full forecast'))} &rarr;</a>
      <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">Weather data by RainViewer &nearr;</a>
    </div>
  </div>`;
}

async function renderHappening(cities) {
  try {
    const live = await confirmHappeningNow(cities);
    liveSlugs = new Set(live.map((r) => r.city.slug));
    // The band carries ONLY observed evidence, at most two side by side. A
    // forecast-supported signal is not confirmation and stays off the band.
    const observed = live.filter((r) => r.tier === 'confirmed').slice(0, 2);
    setWatchBand(observed);
    if (currentResult) renderHot(currentResult.cities);
  } catch (err) {
    console.warn('live conditions check failed:', err);
    // A failed check is not evidence of a clear sky, so the band shows its
    // ordinary empty state rather than claiming anything.
    setWatchBand([]);
  }
}

// The band never collapses. With evidence it fills; without, it says nothing is
// confirmed, says that this is ordinary rather than a broken feed, and keeps the
// last confirmed sighting. The live dot goes quiet either way.
function setWatchBand(observed) {
  const has = observed.length > 0;
  happeningEl.innerHTML = has ? observed.map(liveCard).join('') : '';
  happeningEl.hidden = !has;
  watchEmptyEl.hidden = has;
  watchStateEl.classList.toggle('quiet', !has);
  watchLabelEl.textContent = has
    ? fill('Observed ingredients aligned · recent evidence')
    : fill('Nothing confirmed · watching');
  const ages = observed.flatMap((result) => [result.sky?.ageMin, result.radar?.ageMin])
    .filter(Number.isFinite);
  watchStampEl.textContent = has && ages.length
    ? fill('Accepted evidence up to {age} min old', { age: Math.max(...ages) })
    : fill('Observation feeds checked {time}', {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  if (has) {
    rememberLastConfirmed(observed[0]);
  } else {
    renderLastConfirmed();
  }
}

// Last confirmed persists across reloads, because the empty state is the normal
// state and "nothing, ever" is less useful than "nothing since 41 minutes ago".
const LAST_CONFIRMED_KEY = 'bowcast-last-confirmed-v1';

function rememberLastConfirmed(r) {
  try {
    localStorage.setItem(LAST_CONFIRMED_KEY, JSON.stringify({
      name: r.city.name,
      look: r.look,
      sunElevation: r.sunElevation,
      at: Date.now(),
    }));
  } catch (_) {}
}

// The empty state was composed as two cells: the copy, and the last-confirmed
// card beside it. Until this browser has ever seen a confirmation there is no
// card, and the copy alone kept the narrow measure of a column that was not
// there, leaving a band of dead space to its right. `is-solo` lets it compose
// as a single block instead.
function markSolo(solo) {
  if (watchEmptyEl) watchEmptyEl.classList.toggle('is-solo', solo);
}

function renderLastConfirmed() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAST_CONFIRMED_KEY) || 'null'); } catch (_) {}
  if (!saved?.name || !saved.at) {
    watchLastEl.hidden = true;
    markSolo(true);
    return;
  }
  const mins = Math.max(1, Math.round((Date.now() - saved.at) / 60000));
  const when = mins < 60
    ? fill('{n} minutes ago', { n: mins })
    : fill('{n} hours ago', { n: Math.round(mins / 60) });
  const detail = saved.look != null && saved.sunElevation != null
    ? fill('{when}, looking {look} with the sun at {elev} degrees.', {
      when, look: saved.look, elev: saved.sunElevation,
    })
    : when;
  watchLastEl.innerHTML = `<div class="k">${esc(fill('Last confirmed'))}</div>
    <div class="v">${esc(saved.name)}</div>
    <div class="n">${esc(detail)}</div>`;
  watchLastEl.hidden = false;
  markSolo(false);
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

/**
 * The status line and its control move together. Every degraded state offers
 * the retry, and a healthy one shows neither, so the page can never say "try
 * again" with nothing to press.
 */
function setStatus(text, tone) {
  statusEl.textContent = fill(text);
  statusEl.classList.toggle('saved', tone === 'saved');
  statusEl.classList.toggle('error', tone === 'error');
  statusEl.hidden = false;
  retryBtn.hidden = !tone;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.classList.remove('saved', 'error');
  retryBtn.hidden = true;
}

async function refresh() {
  if (!hasRendered) {
    setStatus('Loading the shared worldwide forecast…', null);
  }
  try {
    let result;
    try {
      result = await fetchSharedRanking();
    } catch (apiError) {
      if (!hasRendered) setStatus('Shared forecast is slow. Checking cities on this device…', null);
      result = await rankNow(CITIES, {});
    }
    // `rankNow` drops cities it could not reach and reports the shortfall as
    // coverage rather than throwing, so with no connection at all it resolves
    // with an empty ranking. Rendering that blanked the board and hid the
    // status with it: a total failure presented as "nowhere qualifies", which
    // is a reading, and a wrong one. An empty ranking is a failed refresh.
    if (!result?.cities?.length) throw new Error('the ranking came back with no cities');
    render(result);
    hasRendered = true;
    // A refresh that succeeds clears whatever the last failure left on screen,
    // so a stale "offline" line cannot outlive the connection coming back.
    clearStatus();
    try { localStorage.setItem(NOW_SNAPSHOT_KEY, JSON.stringify(result)); } catch (_) {}
    renderHappening(result.cities);
  } catch (err) {
    console.error('now page refresh failed:', err);
    try {
      const cached = hasRendered
        ? null
        : JSON.parse(localStorage.getItem(NOW_SNAPSHOT_KEY) || 'null');
      if (cached?.intervalSchemaVersion === FORECAST_INTERVAL_SCHEMA_VERSION && cached?.cities?.length) {
        render(cached, { saved: true });
        hasRendered = true;
        setStatus(navigator.onLine
          ? 'A fresh worldwide forecast is unavailable. This saved ranking may be stale and is not a live observation.'
          : 'Offline. This saved ranking may be stale and is not a live observation.', 'saved');
        return;
      }
    } catch (_) {}
    // A failed refresh behind a board that already drew keeps the board and
    // labels it, rather than blanking a ranking the reader can still use.
    if (hasRendered) {
      setStatus(navigator.onLine
        ? 'A fresh worldwide forecast is unavailable. The ranking below is the last one that loaded and is not a live observation.'
        : 'Offline. The ranking below is the last one that loaded and is not a live observation.', 'saved');
      return;
    }
    setStatus('Could not load the worldwide forecast. Check your connection and try again.', 'error');
  }
}

retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true;
  try {
    await refresh();
  } finally {
    retryBtn.disabled = false;
  }
});

showAllBtn.addEventListener('click', () => {
  showAll = !showAll;
  if (currentResult) renderList(currentResult.cities);
});

async function init() {
  initThemeToggles();
  // Webcams only decorate rows the board has already drawn, so the board must
  // not wait on them. This was an unbounded await ahead of the first refresh:
  // one hung request and the page showed nothing at all, with no timeout to
  // end it. It now loads alongside the forecast and fills in if it arrives.
  const webcamsReady = fetchWithTimeout('webcams.json', {}, 5000)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  await refresh();
  webcams = await webcamsReady;
  if (currentResult) renderList(currentResult.cities);
  setInterval(refresh, 10 * 60 * 1000);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) refresh();
  });
}

init();
