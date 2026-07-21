import type { Block, DocFile } from './types';
import { DESSIN_SCIENTIFIQUE } from './figures/dessinScientifique';
import { MATH_POINT_NATURE_CURVES } from './figures/mathPointNatureCurves';

/**
 * Figures redrawn BY HAND for a specific book, keyed by the page and block they replace.
 *
 * Why this exists: the vision-model redraw (`/api/figure`) is prompted for a chemistry textbook and
 * reasons in chart semantics. Pointed at a descriptive-geometry épure it produces confident
 * nonsense — one cached redraw described a Monge projection as an "energy diagram". A dense épure
 * is not a drawing problem, it is a *fabrication* problem: every point position carries meaning, so
 * a model that redraws freehand invents geometry that reads as correct and is not.
 *
 * These SVGs were authored against the scan and checked against a potrace of the page's own ink, so
 * a misplaced point was caught rather than shipped. They are still a RECONSTRUCTION, not evidence —
 * the UI badges them as such and keeps the scan next to them. The scan remains the archive.
 */

export interface AuthoredFigure {
  svg: string;
  caption: string;
  /** Labels on the scan that could not be read, and were therefore left out rather than guessed. */
  omissions?: string[];
}

/** Keyed `page:blockId` (0-based page, as in OcrPage.index). */
export type FigureSet = Record<string, AuthoredFigure>;

interface Book {
  /** Matches the document this set belongs to. Content-ish, not just the filename. */
  match: (doc: DocFile) => boolean;
  figures: FigureSet;
}

// Filename AND page count: a set of figures keyed by page is meaningless against a different
// book, and silently painting the wrong figure onto a page is exactly the corruption this repo
// exists to prevent. Shared with the épure-IR catalog, which keys by the same pages.
export const matchesDessinScientifique = (doc: DocFile): boolean =>
  /dessin[-_ ]?scientifique/i.test(doc.name) && doc.pageCount === 51;

const matchesMaitriserMaths = (doc: DocFile): boolean =>
  /maitriser[-_ ]?les[-_ ]?maths/i.test(doc.name) && doc.pageCount === 570;

const BOOKS: Book[] = [
  {
    match: matchesDessinScientifique,
    figures: DESSIN_SCIENTIFIQUE,
  },
];

export function figureSetFor(doc: DocFile): FigureSet | null {
  return BOOKS.find((b) => b.match(doc))?.figures ?? null;
}

export function authoredFigureCount(doc: DocFile): number {
  const set = figureSetFor(doc);
  return set ? Object.keys(set).length : 0;
}

/**
 * Apply the authored figures to a document's blocks. Pure: returns a new page/block tree, or the
 * same one when there is nothing to apply, so React can skip the update.
 */
export function applyAuthoredFigures(doc: DocFile): DocFile {
  const set = figureSetFor(doc);
  const tableFigures = matchesMaitriserMaths(doc)
    ? { '318:p318-b1': [...MATH_POINT_NATURE_CURVES] }
    : null;
  if ((!set && !tableFigures) || !doc.result) return doc;

  let touched = false;
  const pages = doc.result.pages.map((page) => {
    const blocks = page.blocks.map((block) => {
      const key = `${page.index}:${block.id}`;
      const figures = tableFigures?.[key as keyof typeof tableFigures];
      if (figures) {
        if (block.authoredTableFigures?.join('') === figures.join('')) return block;
        touched = true;
        return { ...block, authoredTableFigures: figures };
      }
      const fig = set?.[key];
      // Already applied and unchanged — leave the object identity alone.
      if (!fig || (block.redrawnAuthored && block.redrawnSvg === fig.svg)) return block;
      touched = true;
      const patch: Partial<Block> = {
        redrawnSvg: fig.svg,
        redrawnCaption: fig.caption,
        redrawnModel: 'authored',
        redrawnAuthored: true,
        authoredOmissions: fig.omissions,
        // An authored figure supersedes whatever the model did or didn't do here.
        redrawnStub: false,
        redrawnCanonical: false,
        redrawNotChart: false,
        redrawReason: undefined,
      };
      return { ...block, ...patch };
    });
    return blocks === page.blocks ? page : { ...page, blocks };
  });

  if (!touched) return doc;
  return { ...doc, result: { ...doc.result, pages } };
}
