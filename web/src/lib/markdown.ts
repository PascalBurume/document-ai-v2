import { marked } from 'marked';
import katex from 'katex';
// mhchem teaches KaTeX the \ce{...} and \pu{...} commands. This is a chemistry textbook, so the
// OCR text (and any typeset formula) routinely contains e.g. $\ce{H2SO4}$ — without this they
// render as broken literal "\ce…" instead of a formula. Side-effect import: it patches `katex`.
import 'katex/contrib/mhchem';

// `breaks: true` — a single newline becomes a real line break, not a collapsed space. Mistral's OCR
// uses a blank line between blocks and a single newline for an intentional line break WITHIN a block
// (a table-of-contents entry, a list item, a step of a derivation). Measured over the whole 570-page
// book: of 3285 single newlines only 30 are mid-sentence wraps — so the default markdown reflow was
// flattening thousands of structured lines into run-on paragraphs (a TOC read as one blob) to save
// 30 spots. Preserving the breaks also mirrors the scan's own layout, which is what a reviewer is
// checking the transcription against.
marked.setOptions({ gfm: true, breaks: true });

// Private-use sentinels bracket each stashed math placeholder. They must survive `marked.parse`
// untouched in EVERY context (paragraph, list — and crucially a table cell), so the KaTeX HTML can
// be restored AFTER marked runs. A NUL-delimited token (the previous scheme) cannot: the CommonMark
// tokenizer replaces U+0000 with U+FFFD, and a space-wrapped token loses its spaces when marked trims
// a cell. PUA chars are not markdown/math syntax, not whitespace, and not escaped or replaced.
const M_OPEN = String.fromCodePoint(0xe020);
const M_CLOSE = String.fromCodePoint(0xe021);

/**
 * Stash every `$$block$$` / `$inline$` (and bare power-of-ten tokens) as rendered KaTeX, leaving an
 * inert placeholder in place. Restoration is deferred to AFTER `marked.parse` (see renderMarkdown):
 * KaTeX's `\sqrt` output is a nested `<svg><path>` blob, and marked's GFM table-cell inline lexer
 * mangles such markup — dropping the tags and spilling the path `d` coordinates as visible text.
 * Keeping math opaque through marked avoids that entirely.
 */
function renderMath(source: string): { text: string; placeholders: string[] } {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    placeholders.push(html);
    return `${M_OPEN}${placeholders.length - 1}${M_CLOSE}`;
  };

  const display = (_m: string, tex: string) => stash(safeKatex(tex, true));
  const inline = (_m: string, tex: string) => stash(safeKatex(tex, false));

  // Display first, so a `$$` isn't caught by the single-`$` inline pass. Mistral's OCR mixes all
  // four delimiters: `$$…$$`, `\[…\]` (display) and `$…$`, `\(…\)` (inline). The `\(…\)` form
  // alone appears hundreds of times in this book; handling only `$` left them as literal text.
  let out = source.replace(/\$\$([\s\S]+?)\$\$/g, display);
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, display);
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, inline);
  out = out.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, inline);

  /*
   * A bare LaTeX command run the OCR emitted with no delimiters at all — `\sqrt[k+1]{\frac{b}{a}}`
   * or `\frac{x}{q^{3}}` sitting in the middle of a French sentence. Consumes the command plus its
   * optional `[…]` argument and any balanced `{…}` groups (one nesting level, which covers
   * `{\frac{b}{a}}`).
   *
   * ORDER MATTERS, and it is the whole reason this sits here rather than below: the token passes
   * that follow would stash the `q^{3}` INSIDE `\frac{x}{q^{3}}` first, leaving a placeholder that
   * KaTeX cannot parse — so the `\frac` would fail to render and print as literal source with a
   * stray typeset `q³` next to it. Whole expressions must be claimed before their parts.
   *
   * `tryRender` decides: valid LaTeX is typeset, anything else — a stray backslash, a markdown
   * escape, a half-written command — is returned untouched. That is what makes a broad pattern
   * safe here.
   */
  out = out.replace(
    /\\[a-zA-Z]+(?:\s*\[[^\]\n]{0,24}\])?(?:\s*\{(?:[^{}\n]|\{[^{}\n]*\})*\})+/g,
    (m: string) => {
      const html = tryRender(m, false);
      return html ? stash(html) : m;
    },
  );

  // Bare power-of-ten / exponent tokens the OCR emitted WITHOUT math delimiters — 10^{-3},
  // 10^-3, 10^{23} — otherwise render as literal text (the exact thing broken about the 0^{-3}
  // reading). Runs after the delimited passes, so anything already inside math is stashed and
  // untouched. Deliberately conservative: a digit base and a caret (TeX syntax that essentially
  // never occurs in French prose), numeric exponent only, so ordinary words are never caught.
  out = out.replace(
    /(?<![\w$\\^])(\d+)\^(?:\{(-?\d+)\}|(-?\d+))/g,
    (_m, base: string, braced: string | undefined, bare: string | undefined) =>
      stash(safeKatex(`${base}^{${braced ?? bare}}`, false)),
  );

  /*
   * Bare sub/superscripts on an identifier — `V_{1}`, `P_{2}`, `x_1`, `a^{2}`.
   *
   * Mistral drops math delimiters INSIDE TABLE CELLS. On p.123 the same sentence writes
   * `$V_1, V_2$ et $V_3$` (typeset) and the table under it writes `|  V_{1} | V_{2} | V_{3} |`
   * (printed raw, as literal `V_{1}`). Measured across this book: 298 such tokens, 238 of them in
   * table rows, on 19 pages. Nothing is inferred here — `V_{1}` IS the LaTeX for V₁; only the `$`
   * was missing. Same family as the power-of-ten pass above.
   *
   * Guards, in order of what they protect:
   *   - the lookbehind rejects a `_` inside a word, so `snake_case`, `file_1` and the `m_{-1}` of
   *     `lim_{-1}` are never touched;
   *   - markdown emphasis (`_mot_`) has no identifier before the underscore, so it cannot match;
   *   - the unbraced form requires a word boundary, so `x_12` is never split into `x_1` then `2`;
   *   - KaTeX itself is the final arbiter: `tryRender` is strict, and anything it refuses is left
   *     exactly as it was rather than replaced with a guess.
   *
   * The braced form deliberately carries NO trailing lookahead: cells like `n_{i}x_{i}` butt two
   * subscripted identifiers together, and requiring a boundary after `}` left the whole cell as raw
   * source. Each identifier is stashed in turn — the lookbehind still sees `}`, which is not a word
   * character, so the second one matches too.
   */
  out = out.replace(
    /(?<![\w$\\^_])([A-Za-zÀ-ÿ])(?:([_^])\{([^{}]{1,16})\}|([_^])(\w)(?![\w]))/g,
    (m: string, base: string, opB: string | undefined, braced: string | undefined, opBare: string | undefined, bare: string | undefined) => {
      const html = tryRender(`${base}${opB ?? opBare}{${braced ?? bare}}`, false);
      return html ? stash(html) : m;
    },
  );

  return { text: out, placeholders };
}

/**
 * Precomposed Unicode for an accent + base letter. Only combinations that HAVE a real precomposed
 * character are listed, on purpose: a lookup miss leaves the macro untouched, so a genuine math
 * accent like `\hat{x}` (no "x-circumflex" exists) is preserved while `\hat{o}` becomes "ô".
 */
const PRECOMPOSED: Record<string, Record<string, string>> = {
  acute: { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý' },
  grave: { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  circ: { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  uml: { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  tilde: { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  cedilla: { c: 'ç', C: 'Ç' },
};
const NAMED: Record<string, string> = { acute: 'acute', grave: 'grave', hat: 'circ', tilde: 'tilde', ddot: 'uml' };
const SYMBOL: Record<string, string> = { "'": 'acute', '`': 'grave', '^': 'circ', '"': 'uml', '~': 'tilde' };

/**
 * Rewrite LaTeX accent macros on a letter to their precomposed Unicode character. The OCR routinely
 * writes French words inside math as `\text{ g/\acute{e}q}` — but `\acute` and friends are MATH-mode
 * accents, so inside `\text{}` KaTeX hard-errors ("Can't use function '\acute' in text mode") and
 * the whole expression renders as red source. Unicode `é` renders in both modes, so normalising up
 * front makes these blocks typeset. A miss (accent+letter with no precomposed form) is left as-is,
 * preserving real math accents.
 */
export function normalizeAccents(tex: string): string {
  // Cedilla is brace-only so it can never swallow \ce{} (mhchem), \cdot, \cos, \chi, …
  let out = tex.replace(/\\c\{\s*([a-zA-Z])\s*\}/g, (m, l: string) => PRECOMPOSED.cedilla[l] ?? m);
  // Named math accents on one braced letter: \acute{e}, \hat{o}, \grave{a}, \tilde{n}, \ddot{i}.
  out = out.replace(
    /\\(acute|grave|hat|tilde|ddot)\s*\{\s*([a-zA-Z])\s*\}/g,
    (m, name: string, l: string) => PRECOMPOSED[NAMED[name]]?.[l] ?? m,
  );
  // Symbol text accents, braced or bare: \'e  \'{e}  \`a  \^o  \"i  \~n.
  out = out.replace(
    /\\(['`^"~])\s*(?:\{\s*([a-zA-Z])\s*\}|([a-zA-Z]))/g,
    (m, sym: string, braced: string | undefined, bare: string | undefined) =>
      PRECOMPOSED[SYMBOL[sym]]?.[(braced ?? bare) as string] ?? m,
  );
  return out;
}

/**
 * Best-effort repair of two more OCR-LaTeX artifacts that make KaTeX hard-error, applied ONLY as a
 * fallback after a strict render has already failed (so valid math never reaches it):
 *   - a leaked `$` delimiter left inside the math (e.g. `V_{$(ml)}`) — a real dollar sign is `\$`;
 *   - an unclosed group (`\mathrm{…` with no matching `}`) — append the missing closers.
 * A presentation fix, like the accent normalisation: the raw OCR text remains the evidence.
 */
function repairTex(tex: string): string {
  let t = tex.replace(/(?<!\\)\$/g, '');
  const opens = (t.match(/(?<!\\)\{/g) || []).length;
  const closes = (t.match(/(?<!\\)\}/g) || []).length;
  if (opens > closes) t += '}'.repeat(opens - closes);
  return t;
}

function tryRender(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, output: 'html' });
  } catch {
    return null;
  }
}

/**
 * One LaTeX string -> HTML, with the accent normalisation, mhchem support and honest red-error
 * fallback the rest of the app renders with. Exported so the editor's live formula preview is the
 * SAME renderer as the page — a preview that lied about what the page will show would be worse than
 * no preview.
 */
export function safeKatex(tex: string, display: boolean): string {
  const normalized = normalizeAccents(tex.trim());
  const rendered = tryRender(normalized, display);
  if (rendered) return rendered;

  const repaired = repairTex(normalized);
  if (repaired !== normalized) {
    const fromRepair = tryRender(repaired, display);
    if (fromRepair) return fromRepair;
  }

  // Genuinely unparseable — render KaTeX's own error markup: a red, hoverable "this didn't parse"
  // signal is a more honest result for a reviewer than a silently wrong guess.
  try {
    return katex.renderToString(normalized, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${display ? '$$' : '$'}${escapeHtml(tex)}${display ? '$$' : '$'}</code>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inline image references (![img-0.jpeg](img-0.jpeg)) are rewritten to the base64 the API
 * returned. Without that map they stay as visible references, which is what the
 * "Extract images" toggle being off should look like.
 */
export function renderMarkdown(source: string, images: Map<string, string> = new Map()): string {
  const { text, placeholders } = renderMath(source);
  const parsed = marked.parse(text, { async: false }) as string;
  // Restore the stashed KaTeX now that marked can no longer mangle it inside a table cell.
  const html = parsed.replace(
    new RegExp(`${M_OPEN}(\\d+)${M_CLOSE}`, 'g'),
    (_m, i: string) => placeholders[Number(i)] ?? '',
  );

  return html.replace(/<img([^>]*?)src="([^"]+)"([^>]*)>/g, (match, pre: string, src: string, post: string) => {
    const data = images.get(src) ?? images.get(src.replace(/^\.\//, ''));
    if (!data) return `<span class="img-ref">🖼 ${escapeHtml(src)}</span>`;
    const url = data.startsWith('data:') ? data : `data:image/jpeg;base64,${data}`;
    return `<img${pre}src="${url}"${post}>`;
  });
}

/* ---------- Suspect-signal highlighting ---------- */

/** A span to wrap in a `<mark>`, in offsets local to the `source` passed to renderMarkdownMarked. */
export interface RenderMark {
  start: number;
  end: number;
  kind: string;
  note: string;
  /** Stable dom id so keyboard nav can scroll to and flash this mark. */
  domId?: string;
}

// Private-use sentinels bracket each mark in the RAW markdown before it is rendered. They are not
// markdown or math syntax and survive `marked`/KaTeX untouched as literal characters, so we can
// swap them for real <mark> tags in the finished HTML — sidestepping the impossible job of mapping
// raw offsets onto transformed output. Suspects never start inside code/math (see suspects.ts), so
// a sentinel only ever lands in prose.
const S_OPEN = String.fromCodePoint(0xe000);
const S_MID = String.fromCodePoint(0xe001);
const S_CLOSE = String.fromCodePoint(0xe002);

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render markdown with the given spans wrapped in `<mark class="suspect suspect-KIND">`. Marks must
 * be non-overlapping; offsets are into `source`. Falls back to plain `renderMarkdown` when empty.
 */
export function renderMarkdownMarked(
  source: string,
  marks: RenderMark[],
  images: Map<string, string> = new Map(),
): string {
  if (!marks.length) return renderMarkdown(source, images);

  const sorted = [...marks].sort((a, b) => a.start - b.start);
  let withSentinels = '';
  let cursor = 0;
  sorted.forEach((mark, i) => {
    if (mark.start < cursor) return; // defensive: drop an overlap rather than corrupt the output
    withSentinels += source.slice(cursor, mark.start);
    withSentinels += `${S_OPEN}${i}${S_MID}${source.slice(mark.start, mark.end)}${S_CLOSE}`;
    cursor = mark.end;
  });
  withSentinels += source.slice(cursor);

  const html = renderMarkdown(withSentinels, images);
  const re = new RegExp(`${S_OPEN}(\\d+)${S_MID}([\\s\\S]*?)${S_CLOSE}`, 'g');
  return html.replace(re, (_m, idx: string, inner: string) => {
    const mark = sorted[Number(idx)];
    const id = mark.domId ? ` id="${escapeAttr(mark.domId)}"` : '';
    return `<mark class="suspect suspect-${mark.kind}"${id} title="${escapeAttr(mark.note)}">${inner}</mark>`;
  });
}
