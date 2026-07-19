import type { OcrPage } from './types';
import { ignoreMask } from './suspects';

/**
 * Bare radicals: `√` typed as a character instead of `\sqrt{…}`.
 *
 * Mistral changes notation inside table cells. The same page, the same pass, emits
 * `$$\sqrt{x+6} + \sqrt{x+1} < \sqrt{7x+4}$$` in prose and then `|  √x+6 |  | 0 | + |` in the sign
 * table below it. On paper a radical carries a vinculum — the overbar — and the overbar is the only
 * thing recording how far the radicand reaches. A bare glyph has no overbar, so `√x+6` silently
 * becomes something a reader parses as (√x)+6. Two different expressions; the page meant one.
 *
 * So this module answers one question per radical: **do we know the reach, or are we guessing?**
 *
 *   - `√2`, `√p(x)` — nothing additive follows the first atom, so the reach was never in question.
 *     Typesetting these is a PRESENTATION fix in the same family as `normalizeAccents`/`repairTex`:
 *     `\sqrt{2}` says exactly what `√2` already said. Restored silently.
 *   - `√x+6` where the document itself writes `\sqrt{x+6}` — the reach is CORROBORATED by the OCR's
 *     own explicit LaTeX for that expression, elsewhere in the same book. Restored, but marked:
 *     unlike the atom case this changes the meaning a reader takes away, so it must not pass as an
 *     unremarkable transcription.
 *   - `√1-cos²y` with nothing corroborating it — the reach is genuinely unrecoverable from text.
 *     **Left exactly as it is.** Guessing a grouping here would be inventing mathematics that is not
 *     on the page: the precise failure this repo exists to catch. `findSuspects` flags it instead.
 *
 * Measured on the 570-page Maitriser book: 128 bare radicals — 102 atoms, 13 corroborated, 13 left
 * alone. The page markdown is never mutated; this runs at render time over a copy.
 */

/** A radicand the document states explicitly, e.g. `x+6` from `\sqrt{x+6}`. Spaces removed. */
export function collectRadicands(pages: OcrPage[]): Set<string> {
  const out = new Set<string>();
  for (const p of pages)
    for (const m of (p.markdown ?? '').matchAll(/\\sqrt\{([^{}]+)\}/g)) {
      const k = m[1].replace(/\s+/g, '');
      // A single atom teaches us nothing we can't already parse, and admitting it here would let a
      // stray `\sqrt{x}` "corroborate" the x of `√x+6` and re-group it wrongly.
      if (/[+\-]/.test(k)) out.add(k);
    }
  return out;
}

/** The first atom after a `√`: a number, an identifier (with optional exponent/argument), or a group. */
const ATOM = /^\s*(\([^()]*\)|[A-Za-zÀ-ÿ0-9]+(?:\^\{?-?\w+\}?)?(?:\([^()]*\))?)/;

/** True when what follows the atom is `+`/`-`, i.e. the overbar's reach decides the meaning. */
const ADDITIVE_NEXT = /^\s*[+\-−]/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a known radicand against the text after a `√`, tolerating the whitespace the OCR sprinkles
 * in (`√x + 6` must still match the radicand `x+6`). Returns the length consumed in the SOURCE.
 */
function matchKnown(after: string, radicand: string): number | null {
  const re = new RegExp('^\\s*' + [...radicand].map(escapeRe).join('\\s*'));
  const m = re.exec(after);
  return m ? m[0].length : null;
}

export interface RadicalRestore {
  text: string;
  /** Silently typeset — the reach was never ambiguous. */
  atoms: number;
  /** Re-grouped from the document's own `\sqrt{…}`; each is marked in the output. */
  corroborated: number;
  /** Left untouched: an additive operator follows and nothing corroborates the reach. */
  ambiguous: number;
}

/**
 * Rewrite bare radicals into LaTeX where — and only where — the reach is known. Pure; operates on a
 * copy of the markdown, never the stored evidence.
 */
export function restoreBareRadicals(md: string, known: ReadonlySet<string>): RadicalRestore {
  if (!md || !md.includes('√')) return { text: md, atoms: 0, corroborated: 0, ambiguous: 0 };

  const mask = ignoreMask(md);
  // Longest first: `x+6` must win over `x+1` on `√x+6`, and any longer radicand over a shorter one.
  const candidates = [...known].sort((a, b) => b.length - a.length);

  let out = '';
  let cursor = 0;
  let atoms = 0;
  let corroborated = 0;
  let ambiguous = 0;

  for (let i = md.indexOf('√'); i !== -1; i = md.indexOf('√', i + 1)) {
    if (mask[i]) continue; // already inside math/code — nothing to repair
    const after = md.slice(i + 1);

    // 1. Does the document itself state a radicand that starts exactly here?
    let hitLen: number | null = null;
    let hit: string | null = null;
    for (const k of candidates) {
      const len = matchKnown(after, k);
      if (len != null) {
        hit = k;
        hitLen = len;
        break;
      }
    }

    const atom = ATOM.exec(after);

    let replacement: string | null = null;
    let consumed = 0;
    if (hit && hitLen != null && (!atom || hitLen > atom[0].length)) {
      // Corroborated re-grouping: marked, because it changes what a reader reads.
      replacement =
        `<span class="radical-restored" title="Grouping restored from this document&#39;s own ` +
        `\\sqrt{${hit}} — the scanned overbar is the evidence, check the page">$\\sqrt{${hit}}$</span>`;
      consumed = hitLen;
      corroborated++;
    } else if (atom && ADDITIVE_NEXT.test(after.slice(atom[0].length))) {
      // Ambiguous and uncorroborated: leave it alone. findSuspects marks it.
      ambiguous++;
    } else if (atom) {
      // Presentation only: `√2` and `\sqrt{2}` say the same thing.
      replacement = `$\\sqrt{${atom[1]}}$`;
      consumed = atom[0].length;
      atoms++;
    }

    if (replacement) {
      out += md.slice(cursor, i) + replacement;
      cursor = i + 1 + consumed;
    }
  }

  out += md.slice(cursor);
  return { text: out, atoms, corroborated, ambiguous };
}
