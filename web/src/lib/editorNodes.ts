import type { OcrPage } from './types';

/**
 * The editor's document model.
 *
 * A page's markdown is split into a flat, ordered list of nodes: freely-editable prose, and ATOMS
 * (formulas, images, tables) that the editor renders as locked chips. The user can move or delete an
 * atom, but never type inside it — so a `$\frac{1-\sqrt{2}}{2}$` or an `![img-0.jpeg](img-0.jpeg)`
 * cannot be corrupted by someone editing the sentence next to it.
 *
 * The whole design rests on ONE invariant:
 *
 *     parsePageToNodes(md).map(n => n.src).join('') === md
 *
 * i.e. the split is LOSSLESS. That is what makes serialization exact: an atom the user never opened
 * is written back byte-for-byte, so editing prose can never silently rewrite a formula. `linkBlocks`
 * (ocr.ts) deliberately is NOT used here — it skips images and short blocks and leaves unmatched
 * gaps, so it cannot reassemble a page. This tokenizer owns every character.
 */

export type NodeKind = 'text' | 'formula' | 'image' | 'table';

export interface EditorNode {
  kind: NodeKind;
  /** The exact original markdown for this node. Concatenating every `src` reproduces the page. */
  src: string;
  /** formula only: the TeX between the delimiters, and whether it was a display ($$…$$ / \[…\]). */
  tex?: string;
  display?: boolean;
  /** image only: the alt text and the reference (filename) from `![alt](ref)`. */
  alt?: string;
  ref?: string;
}

/** True for the kinds the editor locks into a chip. Everything else is editable prose. */
export const isAtom = (n: EditorNode) => n.kind !== 'text';

/**
 * Atom patterns, in priority order. These mirror `renderMath` (markdown.ts) exactly — display before
 * inline, so a `$$` is never chewed up by the single-`$` rule — plus images and GFM tables. Order
 * matters and is the same reason renderMath orders its passes the way it does.
 */
const ATOM_PATTERNS: { kind: NodeKind; re: RegExp; display?: boolean }[] = [
  // A GFM table block: a header row, a delimiter row, then body rows. Whole block is one atom.
  { kind: 'table', re: /^\|.*\|[ \t]*\r?\n\|[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|[ \t]*(\r?\n\|.*\|[ \t]*)*/gm },
  { kind: 'image', re: /!\[([^\]]*)\]\(([^)]*)\)/g },
  { kind: 'formula', re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { kind: 'formula', re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { kind: 'formula', re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { kind: 'formula', re: /(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, display: false },
];

interface Hit {
  start: number;
  end: number;
  kind: NodeKind;
  display?: boolean;
  groups: string[];
}

/** Collect every atom match, earlier patterns winning any overlap (display math before inline, etc). */
function findAtoms(md: string): Hit[] {
  const hits: Hit[] = [];
  const taken = new Uint8Array(md.length);

  for (const { kind, re, display } of ATOM_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(md); m; m = re.exec(md)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!m[0].length) continue;
      let clash = false;
      for (let i = start; i < end; i++) if (taken[i]) { clash = true; break; }
      if (clash) continue; // a higher-priority atom already owns these characters
      for (let i = start; i < end; i++) taken[i] = 1;
      hits.push({ start, end, kind, display, groups: m.slice(1) as string[] });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Split a page's markdown into editable prose and locked atoms. Lossless: every character of `md`
 * ends up in exactly one node's `src`.
 */
export function parsePageToNodes(md: string): EditorNode[] {
  if (!md) return [];
  const nodes: EditorNode[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    if (text) nodes.push({ kind: 'text', src: text });
  };

  for (const hit of findAtoms(md)) {
    pushText(md.slice(cursor, hit.start));
    const src = md.slice(hit.start, hit.end);
    if (hit.kind === 'formula') {
      nodes.push({ kind: 'formula', src, tex: hit.groups[0] ?? '', display: Boolean(hit.display) });
    } else if (hit.kind === 'image') {
      nodes.push({ kind: 'image', src, alt: hit.groups[0] ?? '', ref: hit.groups[1] ?? '' });
    } else {
      nodes.push({ kind: 'table', src });
    }
    cursor = hit.end;
  }
  pushText(md.slice(cursor));
  return nodes;
}

/** The inverse of parsePageToNodes. `serializeNodes(parsePageToNodes(md)) === md` for any md. */
export function serializeNodes(nodes: EditorNode[]): string {
  return nodes.map((n) => n.src).join('');
}

/** Rebuild a formula's `src` from edited TeX, preserving its original delimiter style. */
export function formulaSrc(tex: string, display: boolean): string {
  return display ? `$$${tex}$$` : `$${tex}$`;
}

/**
 * The text the app should SHOW and EXPORT for a page: the user's edit when there is one, otherwise the
 * OCR output. `page.markdown` itself is never overwritten — it stays the original claim the inspector
 * (suspects, second opinion) is measured against, which is why those callers deliberately do NOT use
 * this helper.
 */
export function effectiveMarkdown(page: Pick<OcrPage, 'markdown' | 'editedMarkdown'>): string {
  return page.editedMarkdown ?? page.markdown;
}

/** True when this page carries a user edit that differs from the OCR original. */
export function isEdited(page: Pick<OcrPage, 'markdown' | 'editedMarkdown'>): boolean {
  return page.editedMarkdown != null && page.editedMarkdown !== page.markdown;
}
