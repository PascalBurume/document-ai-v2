/**
 * Free, deterministic, text-only "suspect signals".
 *
 * The premise of this whole project: a model that turns broken OCR into clean prose produces
 * fluent, plausible, WRONG text you cannot catch by reading. The paid vision second-opinion
 * (see `vision.ts`) catches it by reading the page image again — but it costs a call per page.
 *
 * This pass costs nothing. It reads only the markdown the API already returned and marks spans
 * that are *internally* suspicious — places where the text disagrees with itself or contains
 * shapes OCR produces when it guesses. It certifies nothing and corrects nothing; like every
 * signal in this inspector it only says "look here". Recall-biased on purpose: a false underline
 * costs a glance, a missed invention costs a wrong book.
 *
 * Offsets are into the RAW page markdown, the same coordinate space `linkBlocks` uses, so the
 * highlighting composes with the existing two-way-linked segments.
 */

export type SuspectKind =
  | 'accent' // same word appears both accented and bare — one of them is wrong
  | 'mojibake' // replacement char or a UTF-8 mis-decode (Ã©, Â°, …)
  | 'digit-in-word' // l/1, O/0, S/5 confusions: a digit among letters or a letter among digits
  | 'rare-ngram' // vowel-less or long consonant runs — the shape of garble
  | 'stray-caps' // an uppercase letter marooned inside a lowercase word
  | 'punct-run' // a run of sentence punctuation the scanner invented
  | 'path-data' // SVG/coordinate garbage the OCR emitted as text (a run of path commands + numbers)
  | 'bare-radical'; // a `√` typed as a character instead of `\sqrt{…}` — the overbar's reach is lost

/** A vision-disagreement span reuses this shape with `kind: 'vision'` when rendered (see below). */
export type MarkKind = SuspectKind | 'vision';

export interface Suspect {
  start: number;
  end: number;
  kind: SuspectKind;
  /** Human-readable reason, shown on hover. */
  note: string;
}

const VOWELS = 'aeiouyàâäéèêëïîíìôöòóûüùúœæ';
const isVowel = (c: string) => VOWELS.includes(c.toLowerCase());

/** Fold to a lowercase, diacritic-stripped key so `matière` and `matiere` collide. */
function fold(token: string): string {
  return token.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Regions whose contents are not prose and must not be flagged: fenced/inline code, math
 * (`$…$`, `$$…$$` — where `\ce{}` and every LaTeX escape live), HTML comments (the `<!-- p.N -->`
 * page anchors), and link/image URLs. Returns a mask where `true` means "ignore this character".
 */
export function ignoreMask(md: string): Uint8Array {
  const mask = new Uint8Array(md.length);
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`]*`/g,
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]*\$/g,
    /<!--[\s\S]*?-->/g,
    /\]\([^)]*\)/g,
  ];
  for (const re of patterns) {
    for (let m = re.exec(md); m; m = re.exec(md)) {
      for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
    }
  }
  return mask;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Word tokens (letters, combining marks, apostrophes) that begin outside an ignored region. */
function wordTokens(md: string, mask: Uint8Array): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (!mask[m.index]) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Same word, accented in one place and bare in another — the signature of invention. On the
 * accent-free chemistry scan Mistral returned `composée`/`hydrogène` (accents it added) beside a
 * bare `matiere` (an accent it should have added but didn't): both are inconsistencies against the
 * document's own usage. We flag the minority spelling of any word that appears both ways.
 */
function accentInconsistencies(tokens: Token[], out: Suspect[]): void {
  const groups = new Map<string, Map<string, Token[]>>();
  for (const t of tokens) {
    const key = fold(t.text);
    if (key.length < 3) continue; // short words are too noisy to fold
    const surface = t.text.normalize('NFC').toLowerCase();
    let forms = groups.get(key);
    if (!forms) groups.set(key, (forms = new Map()));
    let occ = forms.get(surface);
    if (!occ) forms.set(surface, (occ = []));
    occ.push(t);
  }

  for (const [key, forms] of groups) {
    if (forms.size < 2) continue;
    // Only interesting when a bare form (== folded key) coexists with an accented one.
    const hasBare = forms.has(key);
    const hasAccented = [...forms.keys()].some((s) => s !== key);
    if (!hasBare || !hasAccented) continue;

    const ranked = [...forms.entries()].sort((a, b) => b[1].length - a[1].length);
    const majority = ranked[0][0];
    for (const [surface, occ] of ranked) {
      if (surface === majority) continue;
      for (const t of occ) {
        out.push({
          start: t.start,
          end: t.end,
          kind: 'accent',
          note: `“${t.text}” — appears elsewhere as “${majority}”; one spelling is an OCR/model error`,
        });
      }
    }
  }
}

/** Replacement chars and the classic UTF-8-read-as-latin1 mis-decodes. */
function mojibake(md: string, mask: Uint8Array, out: Suspect[]): void {
  const re = /�+|Ã[\x80-\xbf©®¨´ªº«»§]|Â[\xa0°«»§©®±·]/gu;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (mask[m.index]) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'mojibake',
      note: 'Replacement character or UTF-8 mis-decode — the byte encoding was mangled',
    });
  }
}

/**
 * Digit/letter confusions. Two shapes, both narrow to keep chemistry formulas (`H2O`, `CO2`) out:
 *  - a `0`, `1` or `5` sitting between two lowercase letters (`artic1e`, `d0ssier`);
 *  - an `O`/`l`/`I`/`S`/`B` inside an otherwise-numeric token (`1O0`, `5l`).
 */
function digitLetterConfusions(md: string, mask: Uint8Array, out: Suspect[]): void {
  // Interior digit between lowercase letters — the digit means these aren't plain word tokens,
  // so both shapes are scanned straight off the string.
  const interior = /\p{Ll}[015]\p{Ll}/gu;
  for (let m = interior.exec(md); m; m = interior.exec(md)) {
    if (mask[m.index]) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'digit-in-word',
      note: 'A digit sits between letters — likely an l/1 or O/0 misread',
    });
  }
  // Letters marooned in a number.
  const numeric = /\b[0-9OlISB.,]*[OlISB][0-9OlISB.,]*\b/g;
  for (let m = numeric.exec(md); m; m = numeric.exec(md)) {
    const s = m[0];
    if (mask[m.index] || !/[0-9]/.test(s) || !/[OlISB]/.test(s)) continue;
    out.push({
      start: m.index,
      end: m.index + s.length,
      kind: 'digit-in-word',
      note: 'A letter sits inside a number — likely an O/0, l/1 or S/5 misread',
    });
  }
}

/** The shape of garble: a word with no vowel at all, or a long consonant run. */
function garble(tokens: Token[], out: Suspect[]): void {
  const consonantRun = new RegExp(`[^${VOWELS}\\W\\d]{5,}`, 'iu');
  for (const t of tokens) {
    if (t.text.length < 4) continue;
    const letters = t.text.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && ![...letters].some(isVowel)) {
      out.push({ start: t.start, end: t.end, kind: 'rare-ngram', note: `“${t.text}” has no vowel — likely garbled` });
    } else if (consonantRun.test(t.text)) {
      out.push({ start: t.start, end: t.end, kind: 'rare-ngram', note: `“${t.text}” has an unusual consonant run` });
    }
  }
}

/** An uppercase letter stranded inside a lowercase word (`chiMie`) — an OCR glyph swap. */
function strayCaps(tokens: Token[], out: Suspect[]): void {
  for (const t of tokens) {
    if (/\p{Ll}\p{Lu}\p{Ll}/u.test(t.text)) {
      out.push({ start: t.start, end: t.end, kind: 'stray-caps', note: `“${t.text}” — a capital marooned mid-word` });
    }
  }
}

/** Runs of sentence punctuation the scanner invented (`,,`, `.:.`), but not a real ellipsis. */
function punctRuns(md: string, mask: Uint8Array, out: Suspect[]): void {
  const re = /(?:[,;:!?]\s?){2,}|\.{4,}/g;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (mask[m.index]) continue;
    out.push({ start: m.index, end: m.index + m[0].trimEnd().length, kind: 'punct-run', note: 'A run of punctuation — likely scanner noise' });
  }
}

// SVG path-command letters. A run made only of these, digits and separators is the shape of vector
// path data — which Mistral's OCR sometimes emits as literal text (e.g. a `\sqrt` radical read as its
// rendered `<path d="M834 80h400000v40h-400000z"/>` coordinates). See RUNBOOK / the maths book p.26.
const PATH_CMD = 'MmLlHhVvCcSsQqTtAaZz';
const PATH_RUN = new RegExp(`[-+0-9.,eE\\s${PATH_CMD}]{25,}`, 'g');
const CMD_GLUED = new RegExp(`[${PATH_CMD}]-?\\d`, 'g'); // c0.7 / H400000 — command fused to a number

/**
 * Coordinate / SVG-path garbage the OCR emitted as text. A maximal run of nothing but numbers,
 * separators and path-command letters, long and dense enough to be vector data.
 *
 * The decisive signal is **path-command letters fused to numbers** (`c0.7`, `H400000`, `s-225`,
 * `v40`) — the literal shape of an SVG `d` attribute, which never occurs in prose. A plain digit
 * list ("les chiffres 0,1,2,3,4,5,6" — a real combinatorics problem in this book), a comma list, a
 * money figure, or a coordinate pair has none of it, so none of them trip the detector. Requiring
 * two such fused tokens (not a comma-density heuristic) is what keeps the false-positive rate at 0.
 */
/**
 * A `√` typed as a bare character instead of `\sqrt{…}`.
 *
 * On the page, a radical carries a vinculum — the overbar — and the overbar is what says how far
 * the radicand reaches. A character has no overbar, so `√x+6` no longer distinguishes √(x+6) from
 * (√x)+6: two different expressions, and the text alone cannot tell you which one the page meant.
 * The information was destroyed at transcription; nothing downstream can recover it, and a renderer
 * that guessed a grouping would be inventing mathematics. So this only marks where to look.
 *
 * `ignoreMask` already covers `$…$`/`$$…$$`, so a `√` that reaches this function is by construction
 * one the OCR failed to express as LaTeX — the same model emits `\sqrt{x+6}` correctly in prose and
 * then drops to a bare glyph inside table cells.
 *
 * Recall-biased, like every detector here: `√2` is perfectly unambiguous and still gets underlined.
 * A glance costs nothing; a silently re-grouped inequality costs the book.
 */
function bareRadicals(md: string, mask: Uint8Array, out: Suspect[]): void {
  for (let i = md.indexOf('√'); i !== -1; i = md.indexOf('√', i + 1)) {
    if (mask[i]) continue; // inside math/code — already expressed properly
    // Underline the radical and whatever it plausibly reaches over, so the eye lands on the
    // ambiguity itself rather than a lone glyph.
    const rest = md.slice(i + 1);
    const reach = /^\s*[A-Za-zÀ-ÿ0-9(){}[\].,+\-*/^_|·×÷]*/.exec(rest)?.[0] ?? '';
    const end = i + 1 + Math.min(reach.trimEnd().length, 24);
    out.push({
      start: i,
      end: Math.max(end, i + 1),
      kind: 'bare-radical',
      note:
        'A “√” written as a character, not as \\sqrt{…} — the overbar is gone, so how far the ' +
        'radical reaches is no longer recorded. Check the scan: √x+6 and √(x+6) are different.',
    });
  }
}

function pathData(md: string, mask: Uint8Array, out: Suspect[]): void {
  for (let m = PATH_RUN.exec(md); m; m = PATH_RUN.exec(md)) {
    if (mask[m.index]) continue;
    const run = m[0];
    const digits = (run.match(/\d/g) ?? []).length;
    const cmdGlued = (run.match(CMD_GLUED) ?? []).length;
    if (digits < 8 || cmdGlued < 2) continue;
    // Trim surrounding whitespace so the underline hugs the garbage, not the gap before it.
    const lead = run.length - run.trimStart().length;
    const trimmed = run.trim();
    out.push({
      start: m.index + lead,
      end: m.index + lead + trimmed.length,
      kind: 'path-data',
      note: 'Looks like SVG/coordinate path data emitted as text — the OCR failed to read this region',
    });
  }
}

const MAX_SUSPECTS = 300;

/**
 * Scan one page's markdown and return suspect spans, sorted, non-overlapping (first match wins on
 * overlap, mirroring `linkBlocks`). Pure and cheap — safe to call on every render behind a memo.
 */
export function findSuspects(markdown: string): Suspect[] {
  if (!markdown) return [];
  const mask = ignoreMask(markdown);
  const tokens = wordTokens(markdown, mask);

  const raw: Suspect[] = [];
  accentInconsistencies(tokens, raw);
  mojibake(markdown, mask, raw);
  digitLetterConfusions(markdown, mask, raw);
  garble(tokens, raw);
  strayCaps(tokens, raw);
  punctRuns(markdown, mask, raw);
  pathData(markdown, mask, raw);
  bareRadicals(markdown, mask, raw);

  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Suspect[] = [];
  let cursor = 0;
  for (const s of raw) {
    if (s.start < cursor) continue; // overlaps an already-kept span
    kept.push(s);
    cursor = s.end;
    if (kept.length >= MAX_SUSPECTS) break;
  }
  return kept;
}

/* ---------- Combined page marks (free suspects + paid vision disagreements) ---------- */

import type { OcrPage } from './types';

/** A span to underline in the Text tab. Vision disagreements ride the same shape as free suspects. */
export interface Mark {
  start: number;
  end: number;
  kind: MarkKind;
  note: string;
}

/** Locate a bare substring in markdown, tolerant of whitespace/case differences. Returns -1 on miss. */
function locate(markdown: string, needle: string): { start: number; end: number } | null {
  const trimmed = needle.trim();
  if (trimmed.length < 2) return null;
  const direct = markdown.indexOf(trimmed);
  if (direct !== -1) return { start: direct, end: direct + trimmed.length };
  // Fall back to a whitespace/case-folded search, mapping the hit back to original offsets.
  const foldWs = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  const hayFolded = foldWs(markdown);
  const at = hayFolded.indexOf(foldWs(trimmed));
  if (at === -1) return null;
  // hayFolded only collapses runs, so offsets stay close; clamp to the original length.
  return { start: Math.min(at, markdown.length - 1), end: Math.min(at + trimmed.length, markdown.length) };
}

/**
 * The full set of marks for one page: the free text-only suspects plus any located vision
 * disagreements (`page.visionNotes`). Deterministic and sorted, so the same call in the renderer
 * and in the keyboard-nav index produces identical ordering and therefore matching element ids.
 */
export function buildPageMarks(page: OcrPage): Mark[] {
  const marks: Mark[] = findSuspects(page.markdown);
  for (const n of page.visionNotes ?? []) {
    const span = locate(page.markdown, n.ocr);
    if (!span) continue; // still listed in the second-opinion panel; just not located in the text
    marks.push({
      ...span,
      kind: 'vision',
      note: `second reading: OCR “${n.ocr}” vs page “${n.image}”${n.kind ? ` (${n.kind})` : ''}`,
    });
  }
  // Vision disagreements are the higher-signal mark, so let them win any overlap with a free one.
  marks.sort((a, b) => a.start - b.start || (a.kind === 'vision' ? -1 : 1));
  const kept: Mark[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  return kept;
}

/** Short label per kind, for the legend and the count chip. */
export const SUSPECT_LABELS: Record<SuspectKind, string> = {
  accent: 'accent mismatch',
  mojibake: 'mangled encoding',
  'digit-in-word': 'digit/letter mixup',
  'rare-ngram': 'garbled shape',
  'stray-caps': 'stray capital',
  'punct-run': 'punctuation noise',
  'path-data': 'coordinate/SVG garbage',
  'bare-radical': 'radical without grouping',
};
