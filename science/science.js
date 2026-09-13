/* Science page: the document's chrome and every figure, drawn from the real
   formulas and the real backtest numbers. No chart library and no CDN: each
   figure is hand-drawn SVG so nothing on this page is a black box.

   Colors come through CSS custom properties, so every chart re-inks itself
   when the theme flips (SVG presentation attributes accept var()). */

import { renderInlineMath } from './inline-math.js';
import { SCIENCE_DATA } from './science-data.js';
import { initThemeToggles } from '../theme.js';

const C = {
  ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--line)', lineSoft: 'var(--line-soft)',
  // Bars that carry no level use --line, not the --s3 bar track: on light paper
  // --s3 is white, which vanishes against the panel it sits on.
  track: 'var(--line)', paper: 'var(--paper)',
  red: 'var(--red)', amber: 'var(--amber)', teal: 'var(--teal)', violet: 'var(--violet)',
  good: 'var(--color-good)', textGood: 'var(--text-good)', textHigh: 'var(--text-high)',
  textModerate: 'var(--text-moderate)',
};

const N_WATER = 1.333;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Total deviation of a ray with one internal reflection, in degrees. */
const deviation = (i) => 180 + 2 * i - 4 * deg(Math.asin(Math.sin(rad(i)) / N_WATER));

const set = (id, inner) => { const el = document.getElementById(id); if (el) el.innerHTML = inner; };
const f1 = (n) => n.toFixed(1);
const percent = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1);
const line = (x1, y1, x2, y2, stroke, w, dash) =>
  `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${stroke}" stroke-width="${w || 1}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const text = (x, y, str, o = {}) =>
  `<text x="${f1(x)}" y="${f1(y)}" class="${o.cls || 'fig-tick'}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.fill ? ` fill="${o.fill}"` : ''}>${str}</text>`;
const rect = (x, y, w, h, fill, o = {}) =>
  `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" fill="${fill}"${o.rx ? ` rx="${o.rx}"` : ''}${o.opacity ? ` opacity="${o.opacity}"` : ''}/>`;

/* ── The contents rail ─────────────────────────────────────
   Built from each section's own eyebrow, so it is localized by whatever the
   dictionary put there rather than by a second set of strings. */
function buildRail() {
  const list = document.getElementById('rail-list');
  if (!list) return [];
  const sections = [...document.querySelectorAll('.sci-sec[id]')];
  list.innerHTML = sections.map((sec) => {
    const eyebrow = sec.querySelector('.sec-num');
    const raw = eyebrow ? eyebrow.textContent.trim() : sec.id;
    const parts = raw.split('·');
    const n = parts.length > 1 ? parts[0].trim() : '';
    const name = parts.length > 1 ? parts.slice(1).join('·').trim() : raw;
    return `<li><a href="#${sec.id}">${n ? `<span class="n">${n}</span>` : ''}<span>${name}</span></a></li>`;
  }).join('');
  return sections;
}

/* ── Scroll chrome: progress, reveal, and the rail's place mark ── */
function scrollChrome(sections) {
  const bar = document.getElementById('sci-bar');
  const links = [...document.querySelectorAll('#rail-list a')];
  let queued = false;

  // Every read happens before any write. Setting the bar between the scroll
  // metrics and the section rects invalidated layout mid-frame, so the first
  // getBoundingClientRect had to force a synchronous reflow to answer, once per
  // scroll frame for the length of the article.
  const paint = () => {
    queued = false;
    const doc = document.documentElement;
    const progress = doc.scrollTop / (doc.scrollHeight - doc.clientHeight || 1);
    let active = 0;
    if (links.length) {
      sections.forEach((sec, i) => { if (sec.getBoundingClientRect().top <= 140) active = i; });
    }

    if (bar) bar.style.transform = `scaleX(${progress.toFixed(4)})`;
    if (!links.length) return;
    links.forEach((a, i) => a.classList.toggle('here', i === active));
  };

  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  document.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  paint();

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.sci-fig').forEach((f) => { f.classList.add('reveal'); io.observe(f); });
}

/* ── 1. The deviation curve D(i) ───────────────────────────
   The minimum is found by search rather than asserted, and the shaded band is
   the actual set of incidence angles that exit within one degree of it: the
   caustic, made visible. */
function drawDeviation() {
  const X0 = 64, X1 = 920, Y0 = 44, Y1 = 312, D_LO = 135, D_HI = 182;
  const px = (i) => X0 + (i / 90) * (X1 - X0);
  const py = (d) => Y1 - ((d - D_LO) / (D_HI - D_LO)) * (Y1 - Y0);

  const points = [];
  for (let i = 0; i <= 90; i += 0.5) points.push(`${f1(px(i))},${f1(py(deviation(i)))}`);

  let minI = 0, minD = Infinity;
  for (let k = 0; k <= 900; k++) {
    const d = deviation(k / 10);
    if (d < minD) { minD = d; minI = k / 10; }
  }
  let bandLo = null, bandHi = null;
  for (let k = 0; k <= 900; k++) {
    if (deviation(k / 10) <= minD + 1) { if (bandLo === null) bandLo = k / 10; bandHi = k / 10; }
  }

  let g = rect(px(bandLo), Y0, px(bandHi) - px(bandLo), Y1 - Y0, C.amber, { opacity: '.1' });
  [140, 150, 160, 170, 180].forEach((d) => {
    g += line(X0, py(d), X1, py(d), C.lineSoft, 1);
    g += text(X0 - 10, py(d) + 4, String(d), { anchor: 'end' });
  });
  [0, 15, 30, 45, 60, 75, 90].forEach((i) => g += text(px(i), Y1 + 34, String(i), { anchor: 'middle' }));
  g += line(X0, Y1, X1, Y1, C.line, 1);
  g += line(px(minI), Y0, px(minI), Y1, C.amber, 1, '4 4');
  g += line(X0, py(minD), X1, py(minD), C.amber, 1, '4 4');
  g += `<polyline points="${points.join(' ')}" fill="none" stroke="${C.teal}" stroke-width="2.4"/>`;
  g += `<circle cx="${f1(px(minI))}" cy="${f1(py(minD))}" r="5.5" fill="${C.amber}"/>`;
  // Both annotations stack in the empty upper middle, inside the cup of the
  // curve and above the band they describe: that keeps them clear of the curve,
  // the axis and each other at any figure scale, including the enlarged type a
  // phone needs. The dashed crosshair is what points at the minimum.
  const annotX = px((bandLo + bandHi) / 2);
  g += text(annotX, Y0 + 30, 'many rays exit here', { anchor: 'middle', cls: 'fig-annot' });
  g += text(annotX, Y0 + 74, `${minD.toFixed(0)}&#176; at i = ${minI.toFixed(1)}&#176;`, { anchor: 'middle', cls: 'fig-annot', fill: C.amber });
  g += text(X0 - 10, 22, 'Deviation D, degrees', { cls: 'fig-axis' });
  g += text(X1, Y1 + 62, 'Angle of incidence i, degrees', { anchor: 'end', cls: 'fig-axis' });
  set('deviation-plot', g);
}

/* ── 2. The bow against the sun's elevation ────────────────
   Four concentric circles at the true radii, centred on the antisolar point
   and clipped to the sky, so the arc sinks as the sun climbs. */
const BOW = { scale: 3.6, horizon: 266, cx: 330 };
const BOW_RADII = [[42.4, C.red], [41.8, C.amber], [41.2, C.teal], [40.6, C.violet]];

function drawBow(sun) {
  const { scale, horizon, cx } = BOW;
  const cy = horizon + sun * scale;
  const top = 42 - sun;

  let g = '<defs><clipPath id="skyclip"><rect x="0" y="0" width="640" height="266"/></clipPath></defs>';
  g += '<g clip-path="url(#skyclip)">';
  g += BOW_RADII.map(([a, col]) =>
    `<circle cx="${cx}" cy="${f1(cy)}" r="${f1(a * scale)}" fill="none" stroke="${col}" stroke-width="3"/>`).join('');
  if (sun < 42) g += line(cx, cy, cx, cy - 42.4 * scale, C.muted, 1, '4 4');
  g += `<circle cx="78" cy="${f1(horizon - sun * scale)}" r="13" fill="${C.amber}"/>`;
  g += '</g>';
  g += `<line x1="0" y1="${horizon}" x2="640" y2="${horizon}" stroke="${C.ink}" stroke-width="1.5" opacity=".55"/>`;
  g += text(0, horizon + 26, 'Horizon', { cls: 'fig-axis' });
  g += text(640, horizon + 26, sun >= 42 ? 'nothing to see' : `bow top ${top}&#176;`, { anchor: 'end', cls: 'fig-axis' });
  set('bow-elevation', g);
}

function wireBow() {
  const slider = document.getElementById('sun-slider');
  const out = document.getElementById('sun-out');
  const note = document.getElementById('bow-note');
  if (!slider) return;
  const update = () => {
    const sun = Number(slider.value);
    if (out) out.textContent = `${sun}°`;
    drawBow(sun);
    if (!note) return;
    if (sun >= 42) {
      note.textContent = 'The sun is above 42 degrees, so the whole arc has sunk below the horizon. Bowcast scores this hour zero before it looks at the weather.';
      note.classList.add('gone');
    } else {
      note.textContent = `The top of the bow stands at 42 minus ${sun}, which is ${42 - sun} degrees above the horizon.`;
      note.classList.remove('gone');
    }
  };
  slider.addEventListener('input', update);
  update();
}

/* ── 3. The two factor curves ──────────────────────────────
   f_sun is x^0.4, marked at the ten-minute case from the prose. Drop quality
   is the production piecewise function, drawn as the staircase it is: no
   smoothing, because the cutoffs are the point. */
function drawCurves() {
  const X0 = 46, X1 = 404, Y0 = 16, Y1 = 206;
  const sx = (x) => X0 + x * (X1 - X0);
  const sy = (y) => Y1 - y * (Y1 - Y0);

  const sunPts = [];
  for (let k = 0; k <= 100; k++) { const x = k / 100; sunPts.push(`${f1(sx(x))},${f1(sy(Math.pow(x, 0.4)))}`); }
  const mx = sx(0.17), my = sy(Math.pow(0.17, 0.4));
  let g = line(X0, Y0, X0, Y1, C.line, 1) + line(X0, Y1, X1, Y1, C.line, 1) + line(X0, Y0, X1, Y0, C.lineSoft, 1);
  g += line(mx, my, mx, Y1, C.amber, 1, '4 4') + line(X0, my, mx, my, C.amber, 1, '4 4');
  g += `<polyline points="${sunPts.join(' ')}" fill="none" stroke="${C.teal}" stroke-width="2.4"/>`;
  g += `<circle cx="${f1(mx)}" cy="${f1(my)}" r="5" fill="${C.amber}"/>`;
  g += text(X0 - 6, Y0 + 4, '1.0', { anchor: 'end' }) + text(X0 - 6, Y1 + 4, '0', { anchor: 'end' });
  g += text(mx, Y1 + 22, '0.17', { anchor: 'middle', fill: C.amber });
  g += text(X1, Y1 + 22, '1.0 of the hour', { anchor: 'end' });
  set('plot-sun', g);

  // dropQuality, verbatim from public/core/scoring.js:
  // <= 0.05 -> 0, < 0.2 -> 0.35, < 0.5 -> 0.75, <= 4 -> 1.0, <= 8 -> 0.6, else 0.3
  const dx = (mm) => X0 + (mm / 10) * (X1 - X0);
  const steps = [[0, 0], [0.05, 0], [0.05, 0.35], [0.2, 0.35], [0.2, 0.75], [0.5, 0.75],
    [0.5, 1], [4, 1], [4, 0.6], [8, 0.6], [8, 0.3], [10, 0.3]];
  let d = rect(dx(0.5), Y0, dx(4) - dx(0.5), Y1 - Y0, C.teal, { opacity: '.1' });
  d += line(X0, Y0, X0, Y1, C.line, 1) + line(X0, Y1, X1, Y1, C.line, 1) + line(X0, Y0, X1, Y0, C.lineSoft, 1);
  d += `<polyline points="${steps.map(([mm, q]) => `${f1(dx(mm))},${f1(sy(q))}`).join(' ')}" fill="none" stroke="${C.teal}" stroke-width="2.4"/>`;
  d += text(X0 - 6, Y0 + 4, '1.0', { anchor: 'end' }) + text(X0 - 6, Y1 + 4, '0', { anchor: 'end' });
  d += text(dx(2.25), Y1 + 22, '0.5 to 4', { anchor: 'middle', fill: C.textModerate });
  d += text(X1, Y1 + 22, '10 mm/h', { anchor: 'end' });
  set('plot-drop', d);
}

/* ── 4. The DNI sensitivity check ──────────────────────────
   Mean daily-peak model estimate over full-year 2024 reanalysis, before and
   after the switch to per-member direct normal irradiance. */
function drawDni() {
  const BASE = 236, TOP = 40, BAR = 96, PAIR = 24;
  const MAX = Math.ceil(Math.max(...SCIENCE_DATA.dniComparison.flatMap((row) => [row.before, row.after])) / 10) * 10;
  const h = (v) => ((v / MAX) * (BASE - TOP));
  const groups = SCIENCE_DATA.dniComparison.map((row, index) => ({
    ...row,
    beforeLabel: `${percent(row.before)}%`,
    afterLabel: `${percent(row.after)}%`,
    x: index === 0 ? 150 : 590,
  }));
  let g = line(64, BASE, 920, BASE, C.line, 1);
  groups.forEach((grp) => {
    const bh = h(grp.before), ah = h(grp.after);
    g += rect(grp.x, BASE - bh, BAR, bh, C.track, { rx: 4 });
    g += rect(grp.x + BAR + PAIR, BASE - ah, BAR, ah, C.good, { rx: 4 });
    g += text(grp.x + BAR / 2, BASE - bh - 14, grp.beforeLabel, { anchor: 'middle', cls: 'fig-value', fill: C.muted });
    g += text(grp.x + BAR + PAIR + BAR / 2, BASE - ah - 14, grp.afterLabel, { anchor: 'middle', cls: 'fig-value', fill: C.textGood });
    g += text(grp.x + BAR / 2, BASE + 22, 'before', { anchor: 'middle', cls: 'fig-axis' });
    g += text(grp.x + BAR + PAIR + BAR / 2, BASE + 22, 'after', { anchor: 'middle', cls: 'fig-axis' });
    g += text(grp.x, BASE + 62, grp.name, { cls: 'fig-name' });
  });
  set('dni-chart', g);
}

/* ── 5. The London week ────────────────────────────────────
   Daily peak Conditions scores from the shipped backtest series. The 8th is
   the evening of the photographed double rainbow. */
function drawLondon() {
  const BASE = 236, TOP = 44, X0 = 64, X1 = 920;
  const week = SCIENCE_DATA.london.dailyScores;
  const MAX = Math.ceil(Math.max(...week.map((day) => day.score)) / 5) * 5;
  const slot = (X1 - X0) / week.length;
  const bar = slot - 14;
  let g = line(X0, BASE, X1, BASE, C.line, 1);
  week.forEach((day, i) => {
    const v = day.score;
    const peak = day.date === SCIENCE_DATA.london.bestDate;
    const hgt = Math.max(2, (v / MAX) * (BASE - TOP));
    const x = X0 + i * slot + 7;
    g += rect(x, BASE - hgt, bar, hgt, peak ? C.good : C.track, { rx: 4 });
    g += text(x + bar / 2, BASE - hgt - 14, String(v), { anchor: 'middle', cls: 'fig-value', fill: peak ? C.textGood : C.muted });
    g += text(x + bar / 2, BASE + 26, `Sep ${Number(day.date.slice(-2))}`, { anchor: 'middle', cls: 'fig-axis', fill: peak ? C.ink : C.muted });
  });
  set('london-chart', g);
}

/* ── 6. Honolulu 2024 climatology ──────────────────────────
   Model-qualifying hours from the reanalysis run, by local hour and by month.
   A sanity check on shape, never a count of observed rainbows. */
function drawClimatology() {
  const BASE = 150, TOP = 34, X0 = 30, X1 = 410;

  const byHour = SCIENCE_DATA.climatology.honolulu.hourCounts;
  const hourMax = Math.max(...Object.values(byHour));
  const hours = [];
  for (let h = 6; h <= 20; h++) hours.push(h);
  const hSlot = (X1 - X0) / hours.length;
  let g = line(X0, BASE, X1, BASE, C.line, 1);
  hours.forEach((h, i) => {
    const v = byHour[h] || 0;
    const hgt = Math.max(1, (v / hourMax) * (BASE - TOP));
    const x = X0 + i * hSlot + 2;
    g += rect(x, BASE - hgt, hSlot - 4, hgt, h >= 15 && h <= 18 ? C.amber : C.track, { rx: 2 });
    if (v) g += text(x + (hSlot - 4) / 2, BASE - hgt - 7, String(v), { anchor: 'middle', cls: 'fig-mini' });
    if (h % 3 === 0) g += text(x + (hSlot - 4) / 2, BASE + 20, h > 12 ? `${h - 12}p` : `${h}a`, { anchor: 'middle', cls: 'fig-mini' });
  });
  set('clim-hours', g);

  const byMonth = SCIENCE_DATA.climatology.honolulu.monthCounts;
  const monthMax = Math.max(...Object.values(byMonth));
  const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const mSlot = (X1 - X0) / 12;
  let m = line(X0, BASE, X1, BASE, C.line, 1);
  names.forEach((name, i) => {
    const v = byMonth[i + 1] || 0;
    const hgt = Math.max(1, (v / monthMax) * (BASE - TOP));
    const x = X0 + i * mSlot + 3;
    m += rect(x, BASE - hgt, mSlot - 6, hgt, i <= 4 || i === 11 ? C.violet : C.track, { rx: 2 });
    if (v) m += text(x + (mSlot - 6) / 2, BASE - hgt - 7, String(v), { anchor: 'middle', cls: 'fig-mini' });
    m += text(x + (mSlot - 6) / 2, BASE + 20, name, { anchor: 'middle', cls: 'fig-mini' });
  });
  set('clim-months', m);
}

function applyScienceData() {
  const [honolulu, phoenix] = SCIENCE_DATA.dniComparison;
  const dniDescription = `Mean daily peak model estimate over full-year 2024 reanalysis, before and after the DNI change. Honolulu went from ${percent(honolulu.before)}% to ${percent(honolulu.after)}%; Phoenix went from ${percent(phoenix.before)}% to ${percent(phoenix.after)}%. This is a sensitivity check against historical weather.`;
  const dniChart = document.getElementById('dni-chart');
  if (dniChart) dniChart.setAttribute('aria-label', dniDescription);
  const dniCaption = document.getElementById('dni-caption');
  if (dniCaption) dniCaption.textContent = dniDescription;

  const london = SCIENCE_DATA.london;
  const londonChart = document.getElementById('london-chart');
  if (londonChart) londonChart.setAttribute('aria-label', `Daily peak Conditions scores from ${london.start} through ${london.end}; ${london.bestDate} is highest at ${london.bestScore}/100.`);
  const londonCaption = document.getElementById('london-caption');
  if (londonCaption) londonCaption.textContent = `The model ranked 8 September highest across the seven-day window, at ${london.bestScore}/100. Its strongest modeled interval was ${london.bestHour}, with the sun at ${london.bestSunElevation}°. That is a date-level check, not a match to the photographed evening timing.`;

  const climatology = SCIENCE_DATA.climatology;
  const climatologyResult = document.getElementById('climatology-result');
  if (climatologyResult) climatologyResult.textContent = `Across the 2024 reanalysis runs, Honolulu produced model-qualifying conditions on ${climatology.honolulu.qualifyingDays} days, versus ${climatology.phoenix.qualifyingDays} for Phoenix. This agrees directionally with published climatology.`;
}

/* ── init ──────────────────────────────────────────────── */
function init() {
  applyScienceData();
  renderInlineMath(document.body);
  const sections = buildRail();
  scrollChrome(sections);
  drawDeviation();
  drawCurves();
  drawDni();
  drawLondon();
  drawClimatology();
  wireBow();
  initThemeToggles();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
