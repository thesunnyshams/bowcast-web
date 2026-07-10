/* Science page: KaTeX rendering, scroll chrome, and every figure drawn from
   the real formulas and real backtest numbers. No chart library; hand-drawn SVG
   so nothing is a black box. */

const C = { ink: '#232a35', muted: '#5d6675', line: '#d8d2c4', paper2: '#ece7db',
  red: '#d1495b', amber: '#e0922e', teal: '#2f9e8f', violet: '#7a68d9', accent: '#6f5bd6' };

const NS = 'http://www.w3.org/2000/svg';
const set = (id, inner) => { const e = document.getElementById(id); if (e) e.innerHTML = inner; };
const L = (x1, y1, x2, y2, s, w) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${s}" stroke-width="${w || 1}"/>`;
const T = (x, y, str, o = {}) => `<text x="${x}" y="${y}" font-family="Instrument Sans, sans-serif" font-size="${o.size || 12}" fill="${o.fill || C.muted}" text-anchor="${o.anchor || 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}>${str}</text>`;

/* ── KaTeX ─────────────────────────────────────────────── */
function renderMath() {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  } catch (_) { /* leave the raw TeX rather than crash */ }
}

/* ── Scroll chrome ─────────────────────────────────────── */
function scrollChrome() {
  const bar = document.getElementById('sci-bar');
  const onScroll = () => {
    const h = document.documentElement;
    const p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
    if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
  };
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.sci-fig').forEach((f) => { f.classList.add('reveal'); io.observe(f); });
}

/* ── 1. Deviation curve D(i) ───────────────────────────── */
function drawDeviation() {
  const W = 520, H = 300, pl = 54, pr = 20, pt = 24, pb = 40;
  const n = 1.333;
  const iMax = 90, dMin = 130, dMax = 182;
  const X = (i) => pl + (i / iMax) * (W - pl - pr);
  const Y = (d) => pt + (1 - (d - dMin) / (dMax - dMin)) * (H - pt - pb);
  let pts = [], min = { d: 999, i: 0 };
  for (let i = 0; i <= 90; i += 0.5) {
    const r = Math.asin(Math.sin(i * Math.PI / 180) / n) * 180 / Math.PI;
    const d = 180 + 2 * i - 4 * r;
    pts.push(`${X(i).toFixed(1)},${Y(d).toFixed(1)}`);
    if (d < min.d) min = { d, i };
  }
  let g = '';
  for (let d = 130; d <= 180; d += 10) g += L(pl, Y(d), W - pr, Y(d), C.line, 1) + T(pl - 8, Y(d) + 4, d + '°', { anchor: 'end' });
  for (let i = 0; i <= 90; i += 30) g += T(X(i), H - pb + 18, i + '°', { anchor: 'middle' });
  const mx = X(min.i), my = Y(min.d);
  const aY = pt + 8; // annotation sits in the empty top-centre of the U, clear of the curve
  g += L(mx, aY + 30, mx, H - pb, C.red, 1); // leader through the minimum down to the x-axis
  g += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4" fill="${C.red}"/>`;
  g += T(mx, aY + 12, `D_min ≈ ${min.d.toFixed(0)}° at i ≈ ${min.i.toFixed(0)}°`, { fill: C.red, weight: 600, size: 12.5, anchor: 'middle' });
  g += T(mx, aY + 28, `→ bow at 180 − ${min.d.toFixed(0)} = 42°`, { fill: C.red, size: 11.5, anchor: 'middle' });
  g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${C.ink}" stroke-width="2.5"/>`;
  g += T(W - pr, H - pb + 34, 'angle of incidence  i', { anchor: 'end', size: 11 });
  g += T(pl - 44, pt + 4, 'deviation D', { size: 11, weight: 600 });
  set('deviation-plot', g);
}

/* ── 2. Interactive bow vs sun elevation ───────────────── */
function drawBow(sun) {
  const W = 560, H = 300, horizon = 232, cx = 280, scale = 3.3;
  const antiY = horizon + sun * scale;
  const bands = [[42, C.red], [41, C.amber], [40, C.teal], [39, C.violet]];
  let sky = `<defs><clipPath id="skyclip"><rect x="0" y="0" width="${W}" height="${horizon}"/></clipPath></defs>`;
  sky += `<rect x="0" y="0" width="${W}" height="${horizon}" fill="#eef3f6"/>`;
  sky += `<rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="${C.paper2}"/>`;
  let arcs = bands.map(([a, col]) => `<circle cx="${cx}" cy="${antiY.toFixed(1)}" r="${(a * scale).toFixed(1)}" fill="none" stroke="${col}" stroke-width="3.5" clip-path="url(#skyclip)"/>`).join('');
  const sunY = horizon - sun * scale;
  const sunX = 486;
  let s = `<g clip-path="url(#skyclip)"><circle cx="${sunX}" cy="${sunY.toFixed(1)}" r="13" fill="${C.amber}"/>`;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; s += L(sunX + Math.cos(a) * 18, sunY + Math.sin(a) * 18, sunX + Math.cos(a) * 25, sunY + Math.sin(a) * 25, C.amber, 2); }
  s += '</g>';
  const horiz = L(0, horizon, W, horizon, C.ink, 1.5);
  const bowTop = Math.max(0, 42 - sun);
  let lbl = T(sunX, sunY - 30, `sun ${sun}°`, { anchor: 'middle', fill: C.amber, weight: 600 });
  lbl += T(14, horizon + 22, 'horizon', { size: 11 });
  if (sun < 42) lbl += T(cx, Math.max(20, antiY - 42 * scale - 10), `bow top ${bowTop}°`, { anchor: 'middle', fill: C.ink, weight: 600, size: 12.5 });
  set('bow-elevation', sky + s + arcs + horiz + lbl);
}
function wireBow() {
  const slider = document.getElementById('sun-slider');
  const out = document.getElementById('sun-out');
  const note = document.getElementById('bow-note');
  if (!slider) return;
  const update = () => {
    const sun = +slider.value;
    if (out) out.textContent = sun + '°';
    drawBow(sun);
    if (note) {
      if (sun > 42) { note.textContent = 'The sun is above 42°, so the entire bow is below the horizon: no rainbow, however hard it rains.'; note.classList.add('gone'); }
      else { note.textContent = `The bow stands ${42 - sun}° above the horizon, centred opposite the sun.`; note.classList.remove('gone'); }
    }
  };
  slider.addEventListener('input', update);
  update();
}

/* ── Generic small line plot ───────────────────────────── */
function linePlot(id, fn, x0, x1, y0, y1, opts) {
  const W = 340, H = 190, pl = 46, pr = 12, pt = 14, pb = 30;
  const X = (x) => pl + ((x - x0) / (x1 - x0)) * (W - pl - pr);
  const Y = (y) => pt + (1 - (y - y0) / (y1 - y0)) * (H - pt - pb);
  let g = L(pl, Y(y0), W - pr, Y(y0), C.line, 1) + L(pl, pt, pl, H - pb, C.line, 1);
  (opts.yticks || []).forEach((y) => { g += T(pl - 6, Y(y) + 4, String(y), { anchor: 'end', size: 10 }); g += L(pl, Y(y), W - pr, Y(y), C.line, 0.5); });
  (opts.xticks || []).forEach((x) => g += T(X(x), H - pb + 16, String(x), { anchor: 'middle', size: 10 }));
  let pts = [];
  for (let x = x0; x <= x1 + 1e-9; x += (x1 - x0) / 120) pts.push(`${X(x).toFixed(1)},${Y(fn(x)).toFixed(1)}`);
  g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${opts.color || C.ink}" stroke-width="2.5"/>`;
  if (opts.xlabel) g += T((W + pl) / 2, H - 4, opts.xlabel, { anchor: 'middle', size: 10.5 });
  if (opts.ylabel) { const yc = ((pt + (H - pb)) / 2).toFixed(0); g += `<text x="11" y="${yc}" font-family="Instrument Sans, sans-serif" font-size="10.5" fill="${C.muted}" text-anchor="middle" transform="rotate(-90 11 ${yc})">${opts.ylabel}</text>`; }
  set(id, g);
}

function drawFactorPlots() {
  // sunFactor: x^0.4
  linePlot('plot-sun', (x) => Math.pow(x, 0.4), 0, 1, 0, 1,
    { color: C.amber, xticks: [0, 0.5, 1], yticks: [0, 0.5, 1], xlabel: 'sunlit fraction of hour', ylabel: 'sun factor' });
  // dropQuality piecewise
  const dq = (mm) => mm <= 0.05 ? 0 : mm < 0.2 ? 0.35 : mm < 0.5 ? 0.75 : mm <= 4 ? 1.0 : mm <= 8 ? 0.6 : 0.3;
  // draw as steps by sampling finely
  linePlot('plot-drop', dq, 0, 10, 0, 1.05,
    { color: C.teal, xticks: [0, 2, 4, 6, 8, 10], yticks: [0, 0.5, 1], xlabel: 'rain rate  mm/h', ylabel: 'drop quality' });
}

/* ── Bar chart helper ──────────────────────────────────── */
function barChart(id, groups, opts) {
  // groups: [{ label, bars:[{v,color,tag}] }]
  const W = opts.W || 520, H = opts.H || 240, pl = 44, pr = 16, pt = 22, pb = 46;
  const yMax = opts.yMax, plotW = W - pl - pr, plotH = H - pt - pb;
  const Y = (v) => pt + (1 - v / yMax) * plotH;
  let g = '';
  (opts.yticks || []).forEach((y) => { g += L(pl, Y(y), W - pr, Y(y), C.line, 0.6); g += T(pl - 7, Y(y) + 4, y + (opts.pct ? '%' : ''), { anchor: 'end', size: 10.5 }); });
  const gw = plotW / groups.length;
  groups.forEach((grp, gi) => {
    const bx = pl + gi * gw;
    const nb = grp.bars.length, bw = Math.min(46, (gw - 22) / nb);
    const start = bx + (gw - bw * nb - (nb - 1) * 8) / 2;
    grp.bars.forEach((b, bi) => {
      const x = start + bi * (bw + 8), y = Y(b.v), hgt = Y(0) - y;
      g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hgt).toFixed(1)}" rx="3" fill="${b.color}"/>`;
      g += T(x + bw / 2, y - 6, b.disp != null ? b.disp : b.v + (opts.pct ? '%' : ''), { anchor: 'middle', size: 11, weight: 600, fill: C.ink });
      if (b.tag) g += T(x + bw / 2, Y(0) + 15, b.tag, { anchor: 'middle', size: 9.5 });
    });
    g += T(bx + gw / 2, H - pb + (grp.bars.some((b) => b.tag) ? 30 : 16), grp.label, { anchor: 'middle', size: 11.5, weight: 600, fill: C.ink });
  });
  set(id, g);
}

/* ── Real backtest data ────────────────────────────────── */
function drawData() {
  // DNI fix: mean daily-peak probability, before -> after (full-year 2024)
  barChart('dni-chart', [
    { label: 'Honolulu', bars: [{ v: 39, color: C.line, tag: 'cloud' }, { v: 52, color: C.teal, tag: 'DNI' }] },
    { label: 'Phoenix', bars: [{ v: 6, disp: '6.0%', color: C.line, tag: 'cloud' }, { v: 6.6, color: C.teal, tag: 'DNI' }] },
  ], { yMax: 60, yticks: [0, 20, 40, 60], pct: true });

  // London week daily-peak scores; the 8th (index 3) is the double-rainbow day
  const week = [14, 9, 12, 15, 14, 8, 0];
  barChart('london-chart',
    week.map((v, i) => ({ label: 'Sep ' + (5 + i), bars: [{ v, color: i === 3 ? C.red : C.line }] })),
    { yMax: 18, yticks: [0, 6, 12, 18] });

  // Honolulu 2024 climatology: qualifying hours by local hour, then by month
  const hours = { 7: 1, 8: 3, 9: 1, 10: 1, 15: 2, 16: 4, 17: 7, 18: 13, 19: 1 };
  const W = 520, H = 240, pl = 40, pr = 16, pt = 20, pbHour = 130;
  const hrList = []; for (let h = 6; h <= 20; h++) hrList.push(h);
  const maxH = 14, plotW = W - pl - pr, rowH = 84;
  const Yb = (v, top) => top + (1 - v / maxH) * rowH;
  let g = T(pl, pt - 2, 'Qualifying rainbow hours by local hour of day', { size: 11.5, weight: 600, fill: C.ink });
  const bw = (plotW) / hrList.length - 4;
  hrList.forEach((h, i) => {
    const v = hours[h] || 0, x = pl + i * (plotW / hrList.length), top = pt + 8;
    g += `<rect x="${x.toFixed(1)}" y="${Yb(v, top).toFixed(1)}" width="${bw.toFixed(1)}" height="${(Yb(0, top) - Yb(v, top)).toFixed(1)}" rx="2.5" fill="${h >= 15 && h <= 18 ? C.amber : C.line}"/>`;
    if (h % 3 === 0) g += T(x + bw / 2, top + rowH + 14, (h > 12 ? (h - 12) + 'p' : h + 'a'), { anchor: 'middle', size: 9.5 });
  });
  // by month
  const months = { 1: 16, 2: 2, 5: 11, 10: 4 };
  const maxM = 16, top2 = pt + 8 + rowH + 34;
  g += T(pl, top2 - 8, 'By month', { size: 11.5, weight: 600, fill: C.ink });
  const mbw = plotW / 12 - 5;
  const Ym = (v) => top2 + (1 - v / maxM) * rowH;
  const mn = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  for (let m = 1; m <= 12; m++) {
    const v = months[m] || 0, x = pl + (m - 1) * (plotW / 12);
    g += `<rect x="${x.toFixed(1)}" y="${Ym(v).toFixed(1)}" width="${mbw.toFixed(1)}" height="${(Ym(0) - Ym(v)).toFixed(1)}" rx="2.5" fill="${[1, 2, 3, 4, 5].includes(m) || m === 12 ? C.violet : C.line}"/>`;
    g += T(x + mbw / 2, top2 + rowH + 14, mn[m - 1], { anchor: 'middle', size: 9.5 });
  }
  const clim = document.getElementById('clim-chart');
  if (clim) { clim.setAttribute('viewBox', `0 0 ${W} ${top2 + rowH + 24}`); clim.innerHTML = g; }
}

/* ── init ──────────────────────────────────────────────── */
function init() {
  renderMath();
  scrollChrome();
  drawDeviation();
  drawFactorPlots();
  drawData();
  wireBow();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
