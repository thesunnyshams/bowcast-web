/**
 * BowGauge: the signature Bowcast reading, drawn as a semicircular instrument.
 *
 * A track echoing the 42 degree bow geometry, a proportional level-colored
 * fill, threshold ticks, a needle, and (optionally) the printed value. Color
 * always pairs with the level word and needle position, so the reading never
 * relies on color alone. Framework-free: returns an SVG string, themed by the
 * CSS custom properties in styles.css / theme.css, so it re-skins in dark mode.
 *
 * Usage: el.innerHTML = bowGaugeSVG({ value: 38, display: 'chance', size: 120 });
 */

const CHANCE_LEVEL = (v) => (v >= 45 ? 'strong' : v >= 25 ? 'good' : v >= 10 ? 'fair' : v >= 1 ? 'slim' : 'unlikely');
const SCORE_LEVEL = (v) => (v >= 70 ? 'strong' : v >= 50 ? 'good' : v >= 25 ? 'fair' : v >= 1 ? 'slim' : 'unlikely');

const FILL_VAR = { unlikely: '--color-none', slim: '--color-low', fair: '--color-moderate', good: '--color-good', strong: '--color-high' };
const TEXT_VAR = { unlikely: '--text-none', slim: '--text-low', fair: '--text-moderate', good: '--text-good', strong: '--text-high' };

// Semicircle geometry: centre (100, 102), radius 80, spanning 180deg (left) to 0deg (right).
const CX = 100;
const CY = 102;
const R = 80;

const pt = (deg) => {
  const a = (Math.PI * deg) / 180;
  return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
};

const arc = (fromDeg, toDeg) => {
  const a = pt(fromDeg);
  const b = pt(toDeg);
  const large = Math.abs(fromDeg - toDeg) > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
};

/** Level word ("unlikely" through "strong") for a value on a display scale. */
export function bowGaugeLevel(value, display = 'chance') {
  const v = Math.max(0, Math.min(100, Number(value ?? 0)));
  return display === 'score' ? SCORE_LEVEL(v) : CHANCE_LEVEL(v);
}

/**
 * @param {object} opts
 * @param {number} opts.value       0-100.
 * @param {string} [opts.display]   "chance" (percent) or "score" (N/100).
 * @param {number} [opts.size]      Width in px (height is 0.8x). Default 160.
 * @param {boolean} [opts.showReadout] Print the value + caption below. Default true.
 * @param {string} [opts.level]     Force a level; otherwise derived from bands.
 * @param {string} [opts.caption]   Override the caption line.
 * @returns {string} SVG (+ optional readout) markup.
 */
export function bowGaugeSVG(opts = {}) {
  const display = opts.display === 'score' ? 'score' : 'chance';
  const value = Math.max(0, Math.min(100, Number(opts.value ?? 0)));
  const size = Number(opts.size ?? 160);
  const showReadout = !(opts.showReadout === false || opts.showReadout === 'false');
  const level = opts.level || bowGaugeLevel(value, display);

  const fillColor = `var(${FILL_VAR[level]})`;
  const textColor = `var(${TEXT_VAR[level]})`;

  const valAngle = 180 - (value / 100) * 180; // 180 = left (0), 0 = right (100)
  const trackPath = arc(180, 0);
  const fillPath = value <= 0.5 ? '' : arc(180, valAngle);

  // Needle: a touch shorter than the track radius.
  const na = (Math.PI * valAngle) / 180;
  const nr = R - 6;
  const nx = +(CX + nr * Math.cos(na)).toFixed(2);
  const ny = +(CY - nr * Math.sin(na)).toFixed(2);

  // Threshold ticks at the band edges, so zones read without color.
  const marks = display === 'score' ? [25, 50, 70] : [10, 25, 45];
  const tick = (v) => {
    const a = (Math.PI * (180 - (v / 100) * 180)) / 180;
    const inner = R - 7;
    const outer = R + 7;
    return `<line x1="${(CX + inner * Math.cos(a)).toFixed(2)}" y1="${(CY - inner * Math.sin(a)).toFixed(2)}" x2="${(CX + outer * Math.cos(a)).toFixed(2)}" y2="${(CY - outer * Math.sin(a)).toFixed(2)}"></line>`;
  };

  const scale = size / 160;
  const trackW = (12 * scale).toFixed(1);
  const tipR = (5 * scale).toFixed(1);
  const w = size;
  const h = Math.round(size * 0.8);

  const valueLabel = display === 'score' ? `${Math.round(value)}/100` : `${Math.round(value)}%`;
  const caption = opts.caption || (display === 'score' ? 'Conditions score' : 'Estimated chance');
  const aria = `${caption}: ${valueLabel}, ${level}`;

  const fillEl = fillPath
    ? `<path d="${fillPath}" fill="none" stroke="${fillColor}" stroke-width="${trackW}" stroke-linecap="round"></path>`
    : '';

  const svg = `<svg viewBox="0 0 200 128" width="${w}" height="${h}" role="img" aria-label="${aria}" style="overflow:visible; display:block;">
    <line x1="18" y1="102" x2="182" y2="102" stroke="var(--ink)" stroke-width="1.5" opacity="0.55"></line>
    <path d="${trackPath}" fill="none" stroke="var(--line)" stroke-width="${trackW}" stroke-linecap="round"></path>
    <g stroke="var(--paper)" stroke-width="2.5" opacity="0.9">${marks.map(tick).join('')}</g>
    ${fillEl}
    <line x1="100" y1="102" x2="${nx}" y2="${ny}" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"></line>
    <circle cx="100" cy="102" r="3.5" fill="var(--ink)"></circle>
    <circle cx="${nx}" cy="${ny}" r="${tipR}" fill="${fillColor}" stroke="var(--plaque)" stroke-width="1.5"></circle>
  </svg>`;

  if (!showReadout) return svg;

  const valueSize = Math.round(30 * scale);
  const metaSize = Math.max(9, Math.round(11 * scale));
  const gap = Math.round(8 * scale);
  return `<div style="display:inline-flex; flex-direction:column; align-items:center; gap:${gap}px; font-family:var(--font);">
    ${svg}
    <div style="text-align:center; line-height:1;">
      <div style="font-family:var(--display); font-size:${valueSize}px; color:${textColor}; letter-spacing:-.01em;">${valueLabel}</div>
      <div style="font-size:${metaSize}px; color:var(--muted); margin-top:5px; letter-spacing:.06em; text-transform:uppercase;">${caption}</div>
    </div>
  </div>`;
}
