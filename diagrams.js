/**
 * The two small instrument diagrams: which way to face, and how high the sun is.
 *
 * Both were written for the Now board and are now also the middle and right
 * cells of the city page's facts row, so they live here rather than in either
 * page. Framework-free SVG strings themed by the custom properties in theme.css,
 * with a literal fallback on every painted token for the same reason bowgauge.js
 * carries them: an unresolvable var() computes `stroke` to `none`, which paints
 * the diagram out of existence rather than merely mis-colouring it.
 *
 * Sizes are passed in, not scaled: the Now board draws them a little larger than
 * the city page does, and the label type inside an SVG shrinks with the viewBox.
 */

const AMBER = 'var(--amber, #e5a93f)';
const TEAL = 'var(--teal, #3aab9d)';
const LINE = 'var(--line, #84898f)';
const MUTED = 'var(--muted, #84898f)';
const INK = 'var(--ink, currentColor)';

/** The ceiling a primary bow needs the sun to stay under. */
export const BOW_CEILING_DEG = 42;

/**
 * The sun's height as a wedge from the horizon, with the 42 degree ceiling
 * drawn as a dashed ray so the reading is "how much headroom is left", not a
 * bare number.
 *
 * @param {number} elevDeg sun elevation above the horizon, degrees.
 * @param {{width?: number, height?: number}} [opts]
 * @returns {string} SVG markup.
 */
export function sunDiagram(elevDeg, opts = {}) {
  const width = opts.width ?? 124;
  const height = opts.height ?? 66;
  const rad = (Math.max(0, Math.min(90, elevDeg)) * Math.PI) / 180;
  const R = 40;
  // The ray is 88 long where there is room for it, but the box is only 50 tall
  // above the horizon: past about 35 degrees a fixed length puts the sun above
  // the viewBox, where it is simply not drawn. The Now board reaches those
  // elevations whenever it reports a sun that rules a bow out, and a diagram
  // whose subject has left the frame is worse than a shorter ray. 9 keeps the
  // 5-radius dot clear of the top edge.
  const len = Math.min(88, rad > 0 ? (50 - 9) / Math.sin(rad) : 88);
  const ax = (10 + R * Math.cos(rad)).toFixed(1);
  const ay = (50 - R * Math.sin(rad)).toFixed(1);
  const rayX = (10 + len * Math.cos(rad)).toFixed(1);
  const rayY = (50 - len * Math.sin(rad)).toFixed(1);
  // The label sits in the gap between the ray and the horizon, on the bisector.
  const labelX = (10 + 34 * Math.cos(rad / 2)).toFixed(1);
  const labelY = (50 - 34 * Math.sin(rad / 2) - 6).toFixed(1);
  return `<svg viewBox="0 0 120 64" aria-hidden="true" style="width:${width}px;height:${height}px">
    <path d="M 10 50 L ${10 + R} 50 A ${R} ${R} 0 0 0 ${ax} ${ay} Z" fill="${AMBER}" opacity=".18"></path>
    <line x1="10" y1="50" x2="56.1" y2="8.5" stroke="${LINE}" stroke-width="1" stroke-dasharray="3 3"></line>
    <text x="59" y="12" fill="${MUTED}" style="font-family:var(--mono);font-size:8.5px">${BOW_CEILING_DEG}&deg;</text>
    <line x1="4" y1="50" x2="114" y2="50" stroke="${INK}" stroke-width="1" opacity=".45"></line>
    <path d="M ${10 + R} 50 A ${R} ${R} 0 0 0 ${ax} ${ay}" fill="none" stroke="${AMBER}" stroke-width="1"></path>
    <line x1="10" y1="50" x2="${rayX}" y2="${rayY}" stroke="${AMBER}" stroke-width="1.8"></line>
    <circle cx="${rayX}" cy="${rayY}" r="5" fill="${AMBER}"></circle>
    <text x="${labelX}" y="${labelY}" fill="${AMBER}" style="font-family:var(--mono);font-size:9.5px">${Math.round(elevDeg)}&deg;</text>
  </svg>`;
}

/**
 * The viewing direction as a compass tick. Bearing is clockwise from north, so
 * the needle is drawn pointing up and rotated by it.
 *
 * @param {number} bearing degrees clockwise from north.
 * @param {{width?: number, height?: number}} [opts]
 * @returns {string} SVG markup.
 */
export function compassDiagram(bearing, opts = {}) {
  const width = opts.width ?? 108;
  const height = opts.height ?? 58;
  return `<svg viewBox="0 0 108 58" aria-hidden="true" style="width:${width}px;height:${height}px">
    <circle cx="54" cy="29" r="20" fill="none" stroke="${LINE}" stroke-width="1"></circle>
    <circle cx="54" cy="29" r="2" fill="${MUTED}"></circle>
    <g style="transform:rotate(${Number(bearing) || 0}deg);transform-box:view-box;transform-origin:54px 29px">
      <line x1="54" y1="29" x2="54" y2="6" stroke="${TEAL}" stroke-width="2"></line>
      <path d="M50 11 L54 4 L58 11 Z" fill="${TEAL}"></path>
    </g>
  </svg>`;
}
