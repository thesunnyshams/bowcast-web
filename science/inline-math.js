/*
 * Inline maths for the science page, in place of KaTeX.
 *
 * The page's prose is translated into five languages, and every translation
 * carries the same inline TeX snippets the English does (`\(i\)`,
 * `\(42^\circ - h_\odot\)`, and so on): the maths is language independent, so
 * the dictionaries repeat it verbatim. Dictionary values can never contain
 * markup, because build-pages.js escapes them, which is why the snippets have
 * to stay TeX in the source and be converted here at load.
 *
 * So this is not a TeX engine. It is a converter for one closed set: the
 * snippets that actually appear in public/science/index.html and in the
 * science section of the five dictionaries. Anything outside that set throws,
 * and test/science-math.test.js walks every page string in every locale, so a
 * new snippet fails the suite rather than reaching a reader as raw TeX.
 *
 * Browser-safe and dependency-free: texToHtml() is pure string work, and only
 * renderInlineMath() touches the DOM.
 */

const DEGREE = '°';

/* Macros that stand for one character, or for nothing. */
const SIMPLE = {
  circ: DEGREE,
  odot: '☉',       // the sun symbol, as in h_\odot
  approx: '≈',
  neq: '≠',
  cdot: '·',
  ',': ' ',        // thin space
  ';': ' ',        // medium space
  '!': '',              // negative thin space: nothing to draw
  big: '', bigl: '', bigr: '',   // delimiter sizing: the bracket itself follows
};

/* Macros whose argument is set upright, the way \text does. */
const UPRIGHT = new Set(['text', 'mathrm', 'mathbb']);

/* Everything else a snippet may contain, as itself. */
const LITERAL = new Set([' ', '=', '+', '(', ')', '[', ']', ',', '/', '%', '.']);

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Convert one TeX snippet (without its \( \) delimiters) to HTML. */
export function texToHtml(tex) {
  const s = { src: String(tex), i: 0 };
  const html = run(s, false);
  if (s.i < s.src.length) fail(s, `unexpected "${s.src[s.i]}"`);
  return html;
}

function fail(s, why) {
  throw new Error(`inline-math: ${why} at ${s.i} in "${s.src}"`);
}

/** Parse atoms until the end of the string, or the closing brace of a group. */
function run(s, inGroup) {
  let out = '';
  while (s.i < s.src.length) {
    const ch = s.src[s.i];
    if (ch === '}') {
      if (!inGroup) fail(s, 'unmatched "}"');
      return out;
    }
    out += atom(s);
  }
  if (inGroup) fail(s, 'unclosed group');
  return out;
}

function atom(s) {
  const ch = s.src[s.i];

  if (ch === '\\') return macro(s);
  if (ch === '{') { s.i += 1; const inner = run(s, true); s.i += 1; return inner; }
  if (ch === '^' || ch === '_') { s.i += 1; return script(s, ch); }
  if (ch === '-') { s.i += 1; return '&minus;'; }

  // A run of letters is one italic variable: XY stays a single <var>.
  if (/[A-Za-z]/.test(ch)) {
    const start = s.i;
    while (s.i < s.src.length && /[A-Za-z]/.test(s.src[s.i])) s.i += 1;
    return `<var>${s.src.slice(start, s.i)}</var>`;
  }
  // Numbers are upright, and keep their decimal point.
  if (/[0-9]/.test(ch)) {
    const start = s.i;
    while (s.i < s.src.length && /[0-9.]/.test(s.src[s.i])) s.i += 1;
    return s.src.slice(start, s.i);
  }
  if (LITERAL.has(ch)) { s.i += 1; return ch; }

  return fail(s, `unsupported character "${ch}"`);
}

function macro(s) {
  s.i += 1;   // the backslash
  let name;
  if (/[a-zA-Z]/.test(s.src[s.i] || '')) {
    const start = s.i;
    while (s.i < s.src.length && /[a-zA-Z]/.test(s.src[s.i])) s.i += 1;
    name = s.src.slice(start, s.i);
  } else {
    name = s.src[s.i];
    s.i += 1;
  }

  if (UPRIGHT.has(name)) {
    if (s.src[s.i] !== '{') fail(s, `\\${name} without an argument`);
    s.i += 1;
    const start = s.i;
    while (s.i < s.src.length && s.src[s.i] !== '}') s.i += 1;
    if (s.src[s.i] !== '}') fail(s, `\\${name} argument is unclosed`);
    const text = s.src.slice(start, s.i);
    s.i += 1;
    if (!/^[A-Za-z0-9 .,-]*$/.test(text)) fail(s, `\\${name}{${text}} is not plain text`);
    return `<span class="mtx">${escapeHtml(text)}</span>`;
  }
  if (name in SIMPLE) return SIMPLE[name];

  return fail(s, `unsupported macro "\\${name}"`);
}

/** The argument of ^ or _: a group, a macro, or a single character. */
function script(s, kind) {
  let inner;
  if (s.src[s.i] === '{') { s.i += 1; inner = run(s, true); s.i += 1; }
  else if (s.i < s.src.length) inner = atom(s);
  else return fail(s, `${kind} without an argument`);

  // 42^\circ is a degree sign, not a raised one: it already sits high.
  if (kind === '^' && inner === DEGREE) return DEGREE;
  const tag = kind === '^' ? 'sup' : 'sub';
  return `<${tag}>${inner}</${tag}>`;
}

const INLINE = /\\\(([\s\S]*?)\\\)/g;

/**
 * Replace every \( ... \) run in root's text with rendered HTML. A snippet
 * that fails to convert is left as it was written, so a bad string costs one
 * ugly fragment rather than the paragraph around it.
 */
export function renderInlineMath(root) {
  const scope = root || document.body;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const tag = node.parentNode && node.parentNode.nodeName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    if (node.nodeValue.includes('\\(')) targets.push(node);
  }

  for (const node of targets) {
    // Escape the prose first, then swap the delimited runs for rendered
    // markup: the TeX itself contains no HTML-significant characters, so the
    // two passes cannot interfere.
    const html = escapeHtml(node.nodeValue).replace(INLINE, (whole, tex) => {
      try {
        return `<span class="m">${texToHtml(tex)}</span>`;
      } catch (err) {
        if (typeof console !== 'undefined') console.warn(err.message);
        return whole;
      }
    });
    const holder = document.createElement('span');
    holder.className = 'mwrap';
    holder.innerHTML = html;
    node.parentNode.replaceChild(holder, node);
  }
}
