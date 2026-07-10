/**
 * "Rainbows right now" page. Ranks every city live in the browser (same engine
 * as the map), surfaces the strongest chances with a nearby webcam, and lists
 * the rest by this hour's odds. Webcam ids are baked at build time
 * (scripts/build-webcams.js) so no API key ships to the browser.
 */
import { rankNow } from '../core/now.js';
import { confirmHappeningNow } from '../core/liveConfirm.js';
import { CITIES } from '../core/cities.js';

// Level bands: probability (ensemble) vs quality score (ensemble down).
const PROB_BANDS = [[45, 'high', 'Strong'], [25, 'good', 'Good'], [10, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
const SCORE_BANDS = [[70, 'high', 'Strong'], [50, 'good', 'Good'], [25, 'moderate', 'Fair'], [1, 'low', 'Slim'], [0, 'none', 'Unlikely']];
const classify = (v, isProb) => (isProb ? PROB_BANDS : SCORE_BANDS).find((b) => v >= b[0]);

const statusEl = document.getElementById('now-status');
const happeningEl = document.getElementById('happening');
const hotEl = document.getElementById('hot');
const mainEl = document.getElementById('now-main');
const listEl = document.getElementById('now-list');
const updatedEl = document.getElementById('now-updated');
document.getElementById('city-count').textContent = CITIES.length;

let webcams = {};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const valText = (c) => (c.nowIsProb ? Math.round(c.headline) + '%' : String(c.headline));

const SUN = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" style="vertical-align:-1px;margin-right:3px"><circle cx="8" cy="8" r="3" fill="#e0922e"/><g stroke="#e0922e" stroke-width="1.3" stroke-linecap="round"><path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/></g></svg>';
const MOON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" style="vertical-align:-1px;margin-right:3px"><path d="M11.2 2.7A5.6 5.6 0 1 0 14 11a6.2 6.2 0 0 1-2.8-8.3z" fill="#9aa2b1"/></svg>';

// Returns its own HTML (an inline day/night mark plus escaped text), so callers
// must not re-escape it.
function subtitle(c) {
  const place = [c.region, c.country].filter(Boolean).join(', ');
  const text = place ? `${place} · ${c.localTime} local` : `${c.localTime} local`;
  return `${c.isDay ? SUN : MOON}${esc(text)}`;
}

function peakText(c) {
  if (!c.peakHour) return '';
  return c.peakProb != null ? `Peak today ${c.peakProb}% at ${esc(c.peakHour)}` : `Peak today at ${esc(c.peakHour)}`;
}

function row(c, i) {
  const [, level, word] = classify(c.headline, c.nowIsProb);
  const pct = Math.max(0, Math.min(100, Math.round(c.headline)));
  const peak = peakText(c);
  return `<a class="now-row" href="../rainbow-forecast/${esc(c.slug)}.html">
    <span class="now-rank">${i + 1}</span>
    <span class="now-city">
      <span class="now-name">${esc(c.name)}</span>
      <span class="now-sub">${subtitle(c)}</span>
      <span class="now-bar"><span class="bg-${level}" style="width:${pct}%"></span></span>
      ${peak ? `<span class="now-peak">${peak}</span>` : ''}
    </span>
    <span class="now-right">
      <span class="now-num lv-${level}">${valText(c)}</span>
      <span class="now-word lv-${level}">${word}</span>
    </span>
  </a>`;
}

function camHtml(c) {
  const w = webcams[c.slug];
  if (!w || !w.id) {
    return `<div class="hot-cam"><div class="hot-cam-none">No live camera near ${esc(c.name)} yet.</div></div>`;
  }
  return `<div class="hot-cam"><iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade"
      src="https://webcams.windy.com/webcams/public/embed/player/${encodeURIComponent(w.id)}/day"
      title="Live webcam near ${esc(c.name)}"></iframe></div>
    <div class="hot-cam-credit">Nearby webcam: ${esc(w.title || 'view')} · <a href="https://www.windy.com/webcams/${encodeURIComponent(w.id)}" target="_blank" rel="noopener">open on Windy ↗</a></div>`;
}

function hotCard(c, eyebrow) {
  const [, level, word] = classify(c.headline, c.nowIsProb);
  const peak = c.peakProb != null && c.peakHour ? ` · peak today ${c.peakProb}% at ${esc(c.peakHour)}` : '';
  return `<article class="hot-card">
    ${camHtml(c)}
    <div class="hot-body">
      <div class="hot-eyebrow">${esc(eyebrow)}</div>
      <div class="hot-title">
        <span class="hot-name">${esc(c.name)}</span>
        <span class="hot-num lv-${level}">${valText(c)}</span>
        <span class="hot-word lv-${level}">${word}</span>
      </div>
      <div class="hot-meta">${subtitle(c)}${peak}</div>
      <div class="hot-links">
        <a href="../rainbow-forecast/${esc(c.slug)}.html">Full forecast →</a>
        <a href="../map/?lat=${c.lat}&lon=${c.lon}&label=${encodeURIComponent(c.name)}">Open on map →</a>
      </div>
    </div>
  </article>`;
}

function render({ hasEnsemble, cities }) {
  const hot = cities.filter((c) => (c.nowIsProb ? c.headline >= 45 : c.headline >= 70));

  hotEl.innerHTML = '';
  if (hot.length) {
    hotEl.innerHTML = `<div class="now-section-label">Strong chance this hour</div>` +
      hot.slice(0, 3).map((c) => hotCard(c, 'Rainbow likely right now')).join('');
    hotEl.hidden = false;
  } else if (cities[0] && cities[0].headline > 0) {
    hotEl.innerHTML = hotCard(cities[0], 'Best chance on Earth right now');
    hotEl.hidden = false;
  }

  listEl.innerHTML = cities.slice(0, 20).map((c, i) => row(c, i)).join('');
  mainEl.hidden = false;
  statusEl.hidden = true;

  const now = new Date();
  updatedEl.textContent = `Updated ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    + (hasEnsemble ? '' : ' · quality scores (ensemble offline)');
}

// The live "happening now" board: cities where radar and satellite (or the
// forecast sun where the satellite is dark) agree a bow is probably up this
// minute. Best-effort and additive: a failure here never disturbs the ranking.
function liveCard(r) {
  const c = r.city;
  const rainPhrase = r.quality === 'heavy' ? 'heavy rain' : 'showers';
  const sunPhrase = r.sunSource === 'satellite' ? 'sun confirmed by satellite' : 'sun in the forecast';
  return `<article class="live-card tier-${r.tier}">
    <div class="live-eyebrow">Rainbow likely right now</div>
    <div class="live-title">${esc(c.name)}</div>
    <div class="live-detail"><b>Look ${esc(r.look)}.</b> ${rainPhrase} ${r.rainKm} km out on radar, ${sunPhrase}, sun ${r.sunElevation}&deg; above the horizon.</div>
    <div class="live-links">
      <a href="../map/?lat=${c.lat}&lon=${c.lon}&label=${encodeURIComponent(c.name)}">Open on map →</a>
      <a href="../rainbow-forecast/${esc(c.slug)}.html">Full forecast →</a>
    </div>
  </article>`;
}

async function renderHappening(cities) {
  try {
    const live = await confirmHappeningNow(cities);
    if (!live.length) { happeningEl.hidden = true; happeningEl.innerHTML = ''; return; }
    happeningEl.innerHTML = `<div class="now-section-label">Happening now</div>` + live.slice(0, 4).map(liveCard).join('');
    happeningEl.hidden = false;
  } catch (err) {
    console.warn('live confirm failed:', err);
    happeningEl.hidden = true;
  }
}

let hasRendered = false;

async function refresh() {
  try {
    const result = await rankNow(CITIES, {});
    render(result);
    hasRendered = true;
    renderHappening(result.cities);
  } catch (err) {
    console.error('now page refresh failed:', err);
    if (!hasRendered) {
      statusEl.textContent = 'Could not load the global forecast. Check your connection and refresh.';
      statusEl.classList.add('error');
    }
  }
}

async function init() {
  webcams = await fetch('webcams.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  await refresh();
  // The current hour keeps moving, so re-rank every 10 minutes and whenever the
  // tab is refocused after being hidden for a while. Existing content stays put
  // during a refresh; a failed refresh never wipes a good render.
  setInterval(refresh, 10 * 60 * 1000);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) refresh();
  });
}

init();
