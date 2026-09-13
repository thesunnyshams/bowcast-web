/**
 * BowGauge: the signature Bowcast reading, drawn as a semicircular instrument.
 *
 * A 180 degree dial in a 200x128 viewBox. Baseline at y=102, hub at (100, 102),
 * track radius 80, so the arc is `M 20 102 A 80 80 0 0 1 180 102` and its length
 * is PI * 80 = 251.33. The fill is that same arc dashed to length, the needle is
 * a group rotated (value / 100) * 180 degrees about the hub. Color always pairs
 * with the level word and the needle position, so the reading never relies on
 * color alone.
 *
 * Three sizes, and the differences are deliberate rather than scaled: `s` is a
 * solid blunt dial for map markers, `m` adds a needle arm with threshold ticks,
 * `l` adds numerals and the spectral halo for hero and panel use.
 *
 * Framework-free: returns an SVG string themed by the custom properties in
 * theme.css, so it re-skins with the theme. The load sweep is a CSS animation
 * (see the .bg-* rules in theme.css) rather than a scripted mutation, so the
 * markup is inert and works when interpolated into any page.
 *
 * Usage: el.innerHTML = bowGaugeSVG({ value: 38, display: 'chance', variant: 'l' });
 */

const CHANCE_LEVEL = (v) => (v >= 45 ? 'strong' : v >= 25 ? 'good' : v >= 10 ? 'fair' : v >= 1 ? 'slim' : 'unlikely');
const SCORE_LEVEL = (v) => (v >= 70 ? 'strong' : v >= 50 ? 'good' : v >= 25 ? 'fair' : v >= 1 ? 'slim' : 'unlikely');

const FILL_VAR = { unlikely: '--color-none', slim: '--color-low', fair: '--color-moderate', good: '--color-good', strong: '--color-high' };
const TEXT_VAR = { unlikely: '--text-none', slim: '--text-low', fair: '--text-moderate', good: '--text-good', strong: '--text-high' };

/*
 * Last-resort literals for every token the dial paints with.
 *
 * A var() that resolves to nothing is not "invalid, ignore it": the property
 * becomes invalid at computed-value time and falls back to unset. `stroke`
 * unsets to `none`, so a single missing token silently paints the arc, the
 * needle and the baseline out of existence and the gauge reads as "the SVG
 * failed to load". That has now bitten this codebase twice (the wordmark's bow
 * in styles.css, then the whole level ramp in content.css), and it can also be
 * reached with the tokens intact: a stale service worker serving last week's
 * theme.css against this week's markup produces exactly the same blank dial.
 *
 * So the dial no longer trusts its host page for anything it paints. Every
 * var() below carries a literal fallback, turning a token gap from an invisible
 * instrument into one that is merely the wrong temperature.
 *
 * The fallbacks are deliberately not a copy of either palette. A literal picked
 * from the dark tokens is cream, and cream on the light paper is just as
 * invisible as the `none` it replaced, so a one-temperature fallback only moves
 * the bug rather than fixing it. Instead: `--ink` falls back to currentColor,
 * which is the host page's own text color and therefore right in both themes,
 * and everything else falls back to a midpoint of the two palettes, which is
 * legible on either background.
 */
const FALLBACK = {
  '--color-none': '#9a9386', '--color-low': '#8574e4', '--color-moderate': '#3aab9d',
  '--color-good': '#e5a93f', '--color-high': '#e36d61',
  '--text-none': '#918d7e', '--text-low': '#8477dc', '--text-moderate': '#45a196',
  '--text-good': '#c7963f', '--text-high': '#d1665c',
  '--violet': '#8574e4', '--teal': '#3aab9d', '--amber': '#e5a93f', '--red': '#de6363',
  // Structural. currentColor is the host page's ink in whichever theme is live,
  // so the needle and baseline can never be painted out.
  '--ink': 'currentColor', '--paper': '#84898f', '--line': '#84898f', '--muted': '#84898f',
};

/** `var(--token, literal)`, so the dial still paints when the token is missing. */
const tok = (name) => `var(${name}, ${FALLBACK[name]})`;

// Dial geometry. The hub sits on the baseline, so the dial rests on its own
// coordinate when used as a map marker anchored at (w/2, 102 * w/200).
const CX = 100;
const CY = 102;
const R = 80;
export const BOWGAUGE_ARC_LENGTH = +(Math.PI * R).toFixed(2); // 251.33

// The three sizes. Not a scale ramp: each column is chosen for its context.
const VARIANTS = {
  s: { trackW: 15, armW: 5, tipR: 0, hubR: 0, hubDotR: 4, ticks: false, numerals: false, tickOut: 0, halo: false },
  m: { trackW: 12, armW: 3.2, tipR: 5.5, hubR: 5, hubDotR: 2, ticks: true, numerals: false, tickOut: 7, halo: false },
  l: { trackW: 13, armW: 2.6, tipR: 6.5, hubR: 7, hubDotR: 2.6, ticks: true, numerals: true, tickOut: 9, halo: true },
};

/** Threshold marks for a display scale, which are also the tick positions. */
export function bowGaugeThresholds(display = 'chance') {
  return display === 'score' ? [25, 50, 70] : [10, 25, 45];
}

// A missing, non-numeric or out-of-range reading reads as empty rather than
// producing NaN geometry: an unusable dial is worse than an honest zero.
const clampValue = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

/** Level word ("unlikely" through "strong") for a value on a display scale. */
export function bowGaugeLevel(value, display = 'chance') {
  const v = clampValue(value);
  return display === 'score' ? SCORE_LEVEL(v) : CHANCE_LEVEL(v);
}

/** The fill and text custom properties for a level, for callers that print the value. */
export function bowGaugeColorVars(level) {
  return { fill: tok(FILL_VAR[level] || FILL_VAR.unlikely), text: tok(TEXT_VAR[level] || TEXT_VAR.unlikely) };
}

// A point on the dial: value 0 is due left, 100 due right.
const at = (value, radius) => {
  const a = (Math.PI * (180 - (value / 100) * 180)) / 180;
  return { x: +(CX + radius * Math.cos(a)).toFixed(2), y: +(CY - radius * Math.sin(a)).toFixed(2) };
};

let gradSeq = 0;

/**
 * @param {object} opts
 * @param {number} opts.value        0-100.
 * @param {string} [opts.display]    "chance" (percent) or "score" (N/100).
 * @param {string} [opts.variant]    "s" | "m" | "l". Default "m".
 * @param {number} [opts.size]       Rendered width in px. Omit for fluid (100%).
 * @param {number} [opts.spreadLow]  Ensemble spread, low end, drawn behind the fill.
 * @param {number} [opts.spreadHigh] Ensemble spread, high end.
 * @param {number} [opts.delay]      Extra ms before the load sweep starts.
 * @param {string} [opts.level]      Force a level; otherwise derived from the bands.
 * @param {boolean} [opts.showReadout] Print the value + caption below. Default false.
 * @param {string} [opts.caption]    Override the readout caption.
 * @returns {string} SVG (+ optional readout) markup.
 */
export function bowGaugeSVG(opts = {}) {
  const display = opts.display === 'score' ? 'score' : 'chance';
  const value = clampValue(opts.value);
  const variant = VARIANTS[opts.variant] ? opts.variant : 'm';
  const cfg = VARIANTS[variant];
  const level = opts.level || bowGaugeLevel(value, display);
  const { fill: fillColor, text: textColor } = bowGaugeColorVars(level);

  const LEN = BOWGAUGE_ARC_LENGTH;
  const track = `M 20 102 A 80 80 0 0 1 180 102`;
  const dashOffset = +(LEN * (1 - value / 100)).toFixed(2);
  const angle = +((value / 100) * 180).toFixed(2);
  const delay = Math.max(0, Number(opts.delay ?? 0));

  // The spectral halo and the gradient it needs exist only on the large dial,
  // so the small ones stay free of defs and ids.
  const gradId = cfg.halo ? `bg-halo-${++gradSeq}` : '';
  const defs = cfg.halo
    ? `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">`
      + `<stop offset="0" stop-color="${tok('--violet')}"></stop>`
      + `<stop offset="0.34" stop-color="${tok('--teal')}"></stop>`
      + `<stop offset="0.66" stop-color="${tok('--amber')}"></stop>`
      + `<stop offset="1" stop-color="${tok('--red')}"></stop>`
      + `</linearGradient></defs>`
    : '';
  const halo = cfg.halo
    ? `<path class="bg-halo" d="M 11 102 A 89 89 0 0 1 189 102" fill="none" stroke="url(#${gradId})" stroke-width="1.5"></path>`
    : '';

  // Threshold ticks are drawn in --paper across the track, cutting it rather
  // than sitting on it, so the zones read without relying on color.
  const marks = bowGaugeThresholds(display);
  const ticks = cfg.ticks
    ? marks.map((m) => {
      const i = at(m, R - cfg.tickOut);
      const o = at(m, R + cfg.tickOut);
      return `<line x1="${i.x}" y1="${i.y}" x2="${o.x}" y2="${o.y}"></line>`;
    }).join('')
    : '';
  // --bg-tick lets a host panel match the ticks to its own surface (the dial
  // cannot know what it is sitting on); --paper is the right default.
  const tickGroup = ticks ? `<g stroke="var(--bg-tick, ${tok('--paper')})" stroke-width="2" opacity="0.9">${ticks}</g>` : '';

  // Numerals sit just outside the track at radius 104. The two extremes would
  // land at x = -4 and 204, outside the viewBox, so they tuck inside and anchor
  // to their own edge instead: the dial must not paint over its neighbours.
  const numerals = cfg.numerals
    ? [0, ...marks, 100].map((m) => {
      const q = at(m, 104);
      const extreme = m === 0 || m === 100;
      const anchor = m === 0 ? 'start' : m === 100 ? 'end' : 'middle';
      const x = m === 0 ? 2 : m === 100 ? 198 : q.x;
      // The two extremes land level with the baseline, so they drop below it
      // rather than straddling it.
      const y = +(q.y + (extreme ? 11 : 3)).toFixed(2);
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${tok('--muted')}">${m}</text>`;
    }).join('')
    : '';
  const numeralGroup = numerals ? `<g class="bg-numerals">${numerals}</g>` : '';

  // Optional uncertainty band: the ensemble spread as a wider, faint dashed
  // segment behind the fill. Only drawn when both ends are real and ordered.
  const lo = opts.spreadLow != null && Number.isFinite(Number(opts.spreadLow)) ? clampValue(opts.spreadLow) : null;
  const hi = opts.spreadHigh != null && Number.isFinite(Number(opts.spreadHigh)) ? clampValue(opts.spreadHigh) : null;
  const hasSpread = lo != null && hi != null && hi > lo;
  const spread = hasSpread
    ? `<path d="${track}" fill="none" stroke="${fillColor}" stroke-width="${cfg.trackW + 9}" stroke-linecap="butt" opacity="0.2"`
      + ` stroke-dasharray="${(((hi - lo) / 100) * LEN).toFixed(2)} ${LEN.toFixed(2)}"`
      + ` stroke-dashoffset="${+(-(lo / 100) * LEN).toFixed(2)}"></path>`
    : '';

  const tip = cfg.tipR > 0
    ? `<circle cx="26" cy="102" r="${cfg.tipR}" fill="${fillColor}" stroke="${tok('--paper')}" stroke-width="1.2"></circle>`
    : '';
  const hub = cfg.hubR > 0
    ? `<circle cx="100" cy="102" r="${cfg.hubR}" fill="${tok('--paper')}" stroke="${tok('--ink')}" stroke-width="1.4"></circle>`
    : '';

  const valueLabel = display === 'score' ? `${Math.round(value)}/100` : `${Math.round(value)}%`;
  const caption = opts.caption || (display === 'score' ? 'Conditions score' : 'Estimated chance');
  const aria = `${caption}: ${valueLabel}, ${level}`;

  const box = opts.size != null
    ? ` width="${Number(opts.size)}" height="${Math.round(Number(opts.size) * 0.64)}"`
    : '';
  const delayStyle = delay ? ` style="--bg-delay:${delay}ms"` : '';

  const svg = `<svg class="bg bg-${variant}" viewBox="0 0 200 128"${box}${delayStyle} role="img" aria-label="${aria}">
    ${defs}
    <line x1="12" y1="102" x2="188" y2="102" stroke="${tok('--ink')}" stroke-width="1" opacity="0.3"></line>
    ${halo}
    <path d="${track}" fill="none" stroke="${tok('--line')}" stroke-width="${cfg.trackW}" stroke-linecap="butt" opacity="0.85"></path>
    ${spread}
    <path class="bg-fill" d="${track}" fill="none" stroke="${fillColor}" stroke-width="${cfg.trackW}" stroke-linecap="butt" stroke-dasharray="${LEN}" stroke-dashoffset="${dashOffset}"></path>
    ${tickGroup}
    ${numeralGroup}
    <g class="bg-arm" style="--bg-angle:${angle}deg">
      <line x1="102" y1="102" x2="26" y2="102" stroke="${tok('--ink')}" stroke-width="${cfg.armW}" stroke-linecap="round"></line>
      ${tip}
    </g>
    ${hub}
    <circle cx="100" cy="102" r="${cfg.hubDotR}" fill="${tok('--ink')}"></circle>
  </svg>`;

  if (!opts.showReadout) return svg;

  return `<div class="bg-readout">
    ${svg}
    <div class="bg-readout-text">
      <div class="bg-value" style="color:${textColor}">${valueLabel}</div>
      <div class="bg-caption">${caption}</div>
    </div>
  </div>`;
}
