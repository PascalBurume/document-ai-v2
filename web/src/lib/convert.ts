import { renderMarkdown } from './markdown';
import { save, stem } from './download';
import { effectiveMarkdown } from './editorNodes';
import { collectRadicands, restoreBareRadicals } from './radicals';
import type { Block, DocFile, OcrPage } from './types';

/**
 * The Convert view: the OCR result assembled into a clean reading document — serif column,
 * typeset math, and figures shown as their AI-redrawn SVG recreation when one exists (falling
 * back to the original crop, then to the plain image-ref chip).
 *
 * The converted document is a PRESENTATION of the OCR result, never a replacement for it: the
 * Text/Markdown tabs and the raw response remain the evidence, and every AI-redrawn figure is
 * visibly labelled. Exports (HTML / Markdown / print-to-PDF) are built from the same rendering.
 */

/** Must match the KaTeX version in package.json — the pre-rendered markup and CSS go together. */
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';

/**
 * Model-authored SVG is injected into the page and into exported files, so strip anything that
 * could execute or phone home: scripts, foreignObject, inline event handlers, and any external
 * or javascript: reference. In-document `#id` references are kept. A hardening layer on top of
 * the server-side sanitize (defense in depth), not a general HTML sanitizer.
 */
export function sanitizeSvg(svg: string): string {
  if (!svg) return '';
  const i = svg.indexOf('<svg');
  const j = svg.lastIndexOf('</svg>');
  if (i === -1 || j === -1) return '';
  return svg
    .slice(i, j + 6)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The filename a figure block goes by in the page markdown. Mistral reports the same figure two
 * ways: the extracted image (text = "img-0.jpeg") and a bbox block whose text is the raw
 * markdown ref ("![img-0.jpeg](img-0.jpeg)"). Both must resolve to the same join key, or the
 * redraw substitution silently misses one of them.
 */
export function figureFilename(block: Block): string {
  const m = block.text.match(/^!\[[^\]]*\]\(\s*(?:\.\/)?([^)\s]+)\s*\)$/);
  return m ? m[1] : block.text;
}

/** `![alt](filename)` for one specific figure, tolerating an optional `./` prefix. */
const imgRefRe = (filename: string) => new RegExp(`!\\[[^\\]]*\\]\\(\\s*(?:\\./)?${escapeRe(filename)}\\s*\\)`, 'g');

const token = (blockId: string) => `%%FIG:${blockId}%%`;

const asImageUri = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`);

/**
 * The labelled AI figure. On screen (`compare` + the original `crop`) it is shown SIDE BY SIDE
 * with the scan crop, so the redraw can be checked against what it claims to reproduce — the whole
 * point of this view. In exports `compare` is off: the final artifact carries the clean redraw
 * only. The label is not decoration — generated content must say so.
 */
/**
 * Text recovered from an image region (Mistral had captured it only as a picture), rendered as
 * Markdown + LaTeX under a figure and clearly labelled as a recovery — never the original OCR. Empty
 * string when the block has no recovered text, so it can be appended unconditionally to any figure.
 */
/**
 * The teaching agent's explanation, rendered under the figure as a clearly-labelled study aid.
 * Deliberately a different visual register from the flags: flags say "look here, something may be
 * wrong"; this says "here is how to understand what you are looking at". It never grades the OCR.
 */
function explainHtml(block: Block): string {
  if (!block.explanation) return '';
  const model = block.explainModel ? ` (${escapeHtml(block.explainModel)})` : '';
  return (
    '<div class="ai-explain"><p class="explain-head"><span class="ai-badge">🎓 explication IA</span> ' +
    `Aide à l'étude générée par un modèle${model} — à vérifier contre le cours ; ce n'est pas une correction.</p>` +
    `<div class="explain-body">${renderMarkdown(block.explanation, new Map())}</div></div>`
  );
}

function recoveredHtml(block: Block): string {
  if (!block.recoveredText) return '';
  const model = block.recoveredModel ? ` (${escapeHtml(block.recoveredModel)})` : '';
  return (
    '<div class="recovered-text"><p class="recovered-head"><span class="ai-badge">text recovered</span> ' +
    `Read from this image region by an OpenAI second reading${model} — the OCR pass had captured it only as a ` +
    'picture. A recovery, not the original OCR evidence.</p>' +
    `<div class="recovered-body">${renderMarkdown(block.recoveredText, new Map())}</div></div>`
  );
}

function figureHtml(block: Block, crop?: string, compare = false): string {
  const svg = sanitizeSvg(block.redrawnSvg ?? '');
  const caption = block.redrawnCaption ? escapeHtml(block.redrawnCaption) : '';
  const flags = figureFlagsHtml(block);

  // A human-authored EXACT reference (periodic table) — not an AI redraw. Neutral label; on screen
  // the fuzzy scan sits beside it so a reviewer can confirm it is the same reference.
  if (block.redrawnCanonical) {
    const badge =
      '<span class="ai-badge canonical">' +
      escapeHtml('Référence exacte — créée à partir de données canoniques (pas un redraw IA du scan).') +
      '</span>';
    if (compare && crop) {
      return (
        '<figure class="ai-figure compare canonical">' +
        '<div class="fig-pair">' +
        `<div class="fig-cell"><img src="${asImageUri(crop)}" alt="original scanned reference"/>` +
        '<figcaption class="fig-label">Original — scan</figcaption></div>' +
        `<div class="fig-cell">${svg}<figcaption class="fig-label">${caption || 'Référence exacte'}</figcaption></div>` +
        '</div>' +
        `<figcaption class="ai-caption">${badge}</figcaption>` +
        flags +
        explainHtml(block) +
        '</figure>'
      );
    }
    return `<figure class="ai-figure canonical">${svg}<figcaption>${caption ? `${caption} ` : ''}${badge}</figcaption>${flags}${explainHtml(block)}</figure>`;
  }

  // A figure redrawn BY HAND from this page (see authoredFigures.ts). It is a reconstruction, not
  // the scan and not an exact external reference — so it always says so.
  //
  // The scan sits beside it in the CHECKING view (Convert, `compare`), where the job is to verify
  // the drawing against the ink. The Book is the READING view: there the figure stands alone, like
  // a figure in a book. Nothing is hidden by that — the badge still names it a reconstruction, the
  // omissions are still printed under it, and the scan is one tab (or one glance at the left pane)
  // away. `compare` is the flag that distinguishes the two, so respect it here as the other kinds do.
  if (block.redrawnAuthored) {
    const omissions = block.authoredOmissions?.length
      ? `<span class="fig-omissions">${escapeHtml(
          `Non repris (illisible sur le scan) : ${block.authoredOmissions.join(', ')}`,
        )}</span>`
      : '';
    const badge =
      '<span class="ai-badge authored">' +
      escapeHtml('Figure redessinée à la main d\'après le scan — reconstruction vérifiée, pas le document original.') +
      '</span>';
    if (compare && crop) {
      return (
        '<figure class="ai-figure compare authored">' +
        '<div class="fig-pair">' +
        `<div class="fig-cell"><img src="${asImageUri(crop)}" alt="figure originale scannée"/>` +
        '<figcaption class="fig-label">Original — scan</figcaption></div>' +
        `<div class="fig-cell">${svg}<figcaption class="fig-label">Redessinée</figcaption></div>` +
        '</div>' +
        `<figcaption class="ai-caption">${caption ? `${caption} ` : ''}${badge}${omissions}</figcaption>` +
        flags +
        explainHtml(block) +
        '</figure>'
      );
    }
    return `<figure class="ai-figure authored">${svg}<figcaption>${caption ? `${caption} ` : ''}${badge}${omissions}</figcaption>${flags}${explainHtml(block)}</figure>`;
  }

  const label = block.redrawnStub
    ? 'Stub example — set OPENAI_API_KEY for a real OpenAI redraw of this figure.'
    : `Figure recreated by AI (${block.redrawnModel ?? 'vision model'}) from the scanned original — not part of the transcription.`;

  if (compare && crop) {
    return (
      '<figure class="ai-figure compare">' +
      '<div class="fig-pair">' +
      `<div class="fig-cell"><img src="${asImageUri(crop)}" alt="original scanned figure"/>` +
      '<figcaption class="fig-label">Original — scan</figcaption></div>' +
      `<div class="fig-cell">${svg}<figcaption class="fig-label">AI redraw${caption ? ` · ${caption}` : ''}</figcaption></div>` +
      '</div>' +
      `<figcaption class="ai-caption"><span class="ai-badge">${escapeHtml(label)}</span></figcaption>` +
      flags +
      figureCriticHtml(block) +
      figureReadingHtml(block) +
      recoveredHtml(block) +
      explainHtml(block) +
      '</figure>'
    );
  }
  return (
    `<figure class="ai-figure">${svg}` +
    `<figcaption>${caption ? `${caption} ` : ''}<span class="ai-badge">${escapeHtml(label)}</span></figcaption>` +
    flags +
    figureCriticHtml(block) +
    recoveredHtml(block) +
    explainHtml(block) +
    '</figure>'
  );
}

/**
 * The critic's remaining mismatches, rendered under the figure as flags (never edits): the places
 * where a second reading of the AI recreation still disagrees with the scan after the automatic
 * retry. Carried by exports too, like the label flags — an unresolved disagreement travels with the
 * document, visibly. Empty when the figure was never compared or came back faithful: an absent
 * flag must not imply a verdict either way.
 */
function figureCriticHtml(block: Block): string {
  const problems = block.redrawProblems ?? [];
  if (!problems.length) return '';
  const model = block.redrawCheckModel ? ` (${escapeHtml(block.redrawCheckModel)})` : '';
  return (
    '<div class="fig-critic">' +
    `<p class="fig-critic-head"><span class="flag-badge">[[FIG?]]</span> Une relecture${model} de la recréation IA ` +
    `diverge du scan sur ${problems.length} point${problems.length === 1 ? '' : 's'} — vérifier le scan :</p>` +
    `<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` +
    '</div>'
  );
}

/**
 * The redraw model's own reading of the crop (ticks, sampled points, parts) — the data the SVG
 * claims to encode, shown collapsed so a human can audit the drawing against it. Checking-view
 * (compare) material only; exports carry the drawing and its flags, not the working.
 */
function figureReadingHtml(block: Block): string {
  if (!block.redrawReading) return '';
  return (
    '<details class="fig-reading"><summary>Lecture du modèle — ce que le SVG prétend encoder</summary>' +
    `<pre>${escapeHtml(block.redrawReading)}</pre></details>`
  );
}

/**
 * The figure label investigator's findings, rendered under the figure as flags (never as edits):
 * each place the independent vision reading disagreed with the OCR. Uses the project's `[[VIS?]]`
 * flag vocabulary so it reads as "look here", not "this was fixed". Empty string when a figure was
 * never checked or came back clean — an absent flag must not imply a verdict either way.
 */
function figureFlagsHtml(block: Block): string {
  const notes = block.labelNotes ?? [];
  if (!notes.length) return '';
  const items = notes
    .map(
      (n) =>
        `<li><span class="vk">${escapeHtml(n.kind)}</span> OCR <code class="vo">${escapeHtml(n.ocr)}</code> ` +
        `↔ figure <code class="vi">${escapeHtml(n.image)}</code></li>`,
    )
    .join('');
  const model = block.labelCheckModel ? ` (${escapeHtml(block.labelCheckModel)})` : '';
  return (
    '<div class="fig-flags">' +
    `<p class="fig-flags-head"><span class="flag-badge">[[VIS?]]</span> A vision reading${model} disagrees with the OCR ` +
    `on ${notes.length} figure label${notes.length === 1 ? '' : 's'} — check the scan:</p>` +
    `<ul>${items}</ul>` +
    '</div>'
  );
}

/**
 * A figure the redraw model judged NOT a data chart (apparatus, reaction scheme, photo, table…):
 * show the ORIGINAL SCAN with a note saying no chart was drawn. This is the fix for the model
 * fabricating a titration curve for a photo of the burette — a kept scan is honest, a fabricated
 * chart is not. Falls back to the plain image-ref chip when no crop was extracted.
 */
function figureKeptHtml(block: Block, crop?: string): string {
  const img = crop
    ? `<img src="${asImageUri(crop)}" alt="original scanned figure"/>`
    : `<span class="img-ref">🖼 ${escapeHtml(figureFilename(block))}</span>`;

  // Only claim "not a chart" when the redraw model actually said so — a plain image the user only
  // ran text recovery on hasn't been assessed as a chart-or-not.
  const notChartNote = block.redrawNotChart
    ? `<figcaption><span class="ai-badge kept">Original scan kept — ${
        block.redrawReason ? escapeHtml(block.redrawReason) : 'not a data chart'
      }. No AI chart was drawn, to avoid fabricating data that is not on the page.</span></figcaption>`
    : '';

  return `<figure class="ai-figure kept">${img}${notChartNote}${recoveredHtml(block)}${explainHtml(block)}${figureFlagsHtml(block)}</figure>`;
}

/**
 * One page of the converted document as HTML. Redrawn figures are swapped in via placeholder
 * tokens BEFORE renderMarkdown (so markdown/math/tables are handled exactly as everywhere else)
 * and substituted AFTER, keeping renderMarkdown untouched. Figures without a redraw fall through
 * to renderMarkdown's own chain: original crop from the images map, else the .img-ref chip.
 */
export function renderConverted(
  page: OcrPage,
  opts: { compare?: boolean; radicands?: ReadonlySet<string> } = {},
): string {
  // A page turned into an EXACT reference (the periodic table): REPLACE the whole page with just the
  // accurate table. Mistral mangled this page into unusable table markup and a runaway number list,
  // so there is nothing of value to keep — the download gets a clean page instead of the garble.
  const canonicalPage = page.blocks.find((b) => b.redrawnCanonical && b.redrawnSvg && b.type !== 'image');
  if (canonicalPage) return figureHtml(canonicalPage, undefined, false);

  const images = new Map<string, string>();
  const redrawn: Block[] = [];
  const kept: Block[] = [];
  for (const block of page.blocks) {
    // Key by filename so a redraw's original crop can be found for the side-by-side, and so
    // renderMarkdown resolves the `![…](file)` ref to the same base64.
    if (block.imageBase64) images.set(figureFilename(block), block.imageBase64);
    if (block.type === 'image' && block.redrawnSvg) redrawn.push(block);
    // A figure kept as a scan (not-a-chart), one whose trapped text was recovered, or one that
    // carries a teaching note: render the original scan plus the labelled extras — never a
    // fabricated redraw.
    else if (block.type === 'image' && (block.redrawNotChart || block.recoveredText || block.explanation))
      kept.push(block);
  }

  // The reading view shows the human's corrected text when there is one — this is presentation, so it
  // gets the best available text. The OCR original stays intact on the page for the inspector.
  let md = effectiveMarkdown(page);
  // A bare `√` carries no overbar, so the reading view would show `√x+6` — which reads as (√x)+6,
  // a different expression from the √(x+6) on the page. Typeset the ones whose reach is known
  // (see radicals.ts); the ones that would need a guess are left alone and stay flagged.
  if (opts.radicands) md = restoreBareRadicals(md, opts.radicands).text;
  for (const block of [...redrawn, ...kept]) md = md.replace(imgRefRe(figureFilename(block)), token(block.id));

  let html = renderMarkdown(md, images);
  for (const block of redrawn) {
    html = html.split(token(block.id)).join(figureHtml(block, images.get(figureFilename(block)), opts.compare));
  }
  for (const block of kept) {
    html = html.split(token(block.id)).join(figureKeptHtml(block, images.get(figureFilename(block))));
  }

  return html;
}

/** Reading CSS for the exported file — the shape of backend/export_html.py's _CSS, ported. */
const READING_CSS = `
  body { margin: 0; background: #fff; color: #1a1a1a; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 24px;
         font: 17px/1.75 Georgia, 'Times New Roman', serif; }
  h1, h2, h3 { line-height: 1.3; }
  img { max-width: 100%; height: auto; }
  /* Figure SVGs only, and only as DIRECT children — never a blanket \`svg\` rule.
     KaTeX draws a radical (and stretchy braces/arrows) as an SVG ~400em wide that its container
     clips; \`max-width:100%\` shrinks it to the container and \`height:auto\` then applies the
     400000:1080 viewBox ratio, collapsing it to ~0.05px tall. The radical vanishes while the space
     KaTeX reserved for it stays — so \`√(2x+5) > x-5\` silently exports as \` 2x+5 > x-5\`.
     KaTeX's SVGs live deep inside spans, so the child combinator is what keeps them out. */
  .ai-figure > svg, .fig-cell > svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 1em 0; }
  td, th { border: 1px solid #d4d4d4; padding: 4px 10px; }
  /* Georgia sets OLDSTYLE figures: its \`0\` is x-height and round, so a sign table's \`0\` reads as
     the letter \`o\`, and its digits are proportional so columns don't align. Georgia ships no
     lining-figure feature, so \`font-variant-numeric\` alone cannot fix it — tables take a serif
     that has lining, tabular figures on every platform this file might be opened on. */
  td, th {
    font-family: 'Times New Roman', 'Liberation Serif', Cambria, Times, serif;
    font-variant-numeric: lining-nums tabular-nums;
  }
  .page { border-top: 1px solid #e6e6e6; padding-top: 24px; margin-top: 24px; }
  .page:first-child { border-top: none; margin-top: 0; padding-top: 0; }
  .page-no { font: 11px/1 sans-serif; color: #767676; margin-bottom: 16px; }
  .img-ref { font: 13px/1 sans-serif; color: #767676; border: 1px dashed #d4d4d4;
             border-radius: 6px; padding: 3px 8px; }
  .ai-figure { margin: 1.5em 0; }
  .ai-figure figcaption { font: 13px/1.5 sans-serif; color: #555; margin-top: 6px; }
  .ai-badge { display: inline-block; font-size: 11px; color: #5b21b6; background: #f3e8ff;
              border-radius: 4px; padding: 1px 6px; }
  .ai-badge.kept { color: #334155; background: #e2e8f0; }
  .ai-figure.kept img { max-width: 420px; }
  .ai-badge.canonical { color: #14532d; background: #dcfce7; }
  .ai-figure.canonical { overflow-x: auto; }
  .ai-figure.canonical > svg { min-width: 760px; width: 100%; height: auto; }
  /* A radical re-grouped from the document's own \\sqrt{…} after the OCR bared the glyph and lost
     the overbar. Correct, but an inference — so the artifact says so rather than passing it off as
     a plain transcription. */
  .radical-restored { border-bottom: 1px dotted #d97706; cursor: help; }
  .recovered-text { margin-top: 10px; border-left: 3px solid #a78bfa; padding: 4px 0 4px 12px; }
  .recovered-head { font: 12px/1.5 sans-serif; color: #555; margin: 0 0 6px; }
  .recovered-body { font-size: 15px; }
  .ai-explain { margin-top: 10px; border-left: 3px solid #34d399; background: #f6fdf9;
                padding: 4px 12px; border-radius: 0 8px 8px 0; }
  .explain-head { font: 12px/1.5 sans-serif; color: #555; margin: 0 0 6px; }
  .explain-body { font-size: 15px; }
  .fig-flags { margin-top: 8px; border-left: 3px solid #d97706; background: #fffbeb;
               padding: 8px 12px; border-radius: 0 6px 6px 0; }
  .fig-flags .fig-flags-head { margin: 0 0 4px; font: 13px/1.5 sans-serif; color: #92400e; }
  .fig-flags .flag-badge { font: 11px/1 ui-monospace, monospace; color: #b45309;
               background: #fef3c7; border-radius: 4px; padding: 1px 5px; }
  .fig-flags ul { margin: 4px 0 0; padding-left: 18px; font: 13px/1.6 sans-serif; }
  .fig-flags code { font-family: ui-monospace, monospace; font-size: 12px; }
  .fig-flags .vo { color: #b91c1c; } .fig-flags .vi { color: #166534; }
  .fig-flags .vk { text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em;
               color: #92400e; margin-right: 4px; }
  .fig-critic { margin-top: 8px; border-left: 3px solid #b45309; background: #fff7ed;
               padding: 8px 12px; border-radius: 0 6px 6px 0; }
  .fig-critic .fig-critic-head { margin: 0 0 4px; font: 13px/1.5 sans-serif; color: #9a3412; }
  .fig-critic .flag-badge { font: 11px/1 ui-monospace, monospace; color: #b45309;
               background: #fed7aa; border-radius: 4px; padding: 1px 5px; }
  .fig-critic ul { margin: 4px 0 0; padding-left: 18px; font: 13px/1.6 sans-serif; }
  @media print {
    .page { break-before: page; border-top: none; }
    .page:first-child { break-before: auto; }
    figure, table, .ai-figure { break-inside: avoid; }
  }
`;

/**
 * The whole converted document as ONE self-contained HTML file. Math is already pre-rendered to
 * KaTeX spans by renderMarkdown, so the file needs no JavaScript at all — only the KaTeX
 * stylesheet, linked from a pinned CDN so the math fonts resolve (the same approach as the
 * accepted exporter in backend/export_html.py).
 */
export function buildHtml(doc: DocFile): string {
  const pages = doc.result?.pages ?? [];
  // Document-wide, so a radical bared in a table cell on one page can be re-grouped from the
  // explicit `\sqrt{…}` the OCR produced for the same expression anywhere in the book.
  const radicands = collectRadicands(pages);
  const sections = pages
    .map(
      (p) =>
        `<section class="page"><div class="page-no">page ${p.index + 1}</div>\n${renderConverted(p, { radicands })}</section>`,
    )
    .join('\n');
  return (
    '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(stem(doc.name))}</title>\n` +
    `<link rel="stylesheet" href="${KATEX_CSS}">\n` +
    `<style>${READING_CSS}</style>\n` +
    '</head>\n<body>\n<main>\n' +
    `<!-- Converted from OCR by Document AI. AI-redrawn figures are labelled; the OCR text and\n     the original scan remain the evidence. -->\n` +
    sections +
    '\n</main>\n</body>\n</html>\n'
  );
}

/**
 * The converted document as a single Markdown file. Redrawn figures are inlined as labelled
 * <figure><svg> blocks (GFM passes raw HTML through); figures without a redraw keep their
 * original ![ref](file) so nothing is silently dropped.
 */
export function buildMarkdown(doc: DocFile): string {
  const pages = doc.result?.pages ?? [];
  const radicands = collectRadicands(pages);
  return pages
    .map((p) => {
      // An inserted exact reference (periodic table) replaces the whole garbled page in the export too.
      const canonicalPage = p.blocks.find((b) => b.redrawnCanonical && b.redrawnSvg && b.type !== 'image');
      if (canonicalPage) return `<!-- page ${p.index + 1} -->\n\n${figureHtml(canonicalPage)}`;

      // Same reasoning as the HTML export: a bare `√` in the source means the reader (and any tool
      // downstream of this .md) sees a different expression from the one on the page.
      let md = restoreBareRadicals(effectiveMarkdown(p), radicands).text;
      for (const block of p.blocks) {
        if (block.type !== 'image') continue;
        if (block.redrawnSvg) {
          md = md.replace(imgRefRe(figureFilename(block)), `\n\n${figureHtml(block)}\n\n`);
        } else if (block.recoveredText) {
          // Keep the scan reference, then append the recovered text as raw Markdown + LaTeX (not
          // rendered HTML) so the exported .md keeps editable source. Labelled as a recovery.
          const ref = `![${figureFilename(block)}](${figureFilename(block)})`;
          md = md.replace(
            imgRefRe(figureFilename(block)),
            `${ref}\n\n<!-- text recovered from the image above by a second reading (${
              block.recoveredModel ?? 'vision model'
            }); not original OCR evidence -->\n\n${block.recoveredText}\n`,
          );
        }
      }
      return `<!-- page ${p.index + 1} -->\n\n${md}`;
    })
    .join('\n\n---\n\n');
}

export function exportHtml(doc: DocFile): void {
  save(new Blob([buildHtml(doc)], { type: 'text/html' }), `${stem(doc.name)}-converted.html`);
}

export function exportMarkdown(doc: DocFile): void {
  save(new Blob([buildMarkdown(doc)], { type: 'text/markdown' }), `${stem(doc.name)}-converted.md`);
}

/**
 * Just the page you are editing. After correcting one page, the thing you actually want is that page —
 * not 570 of them.
 *
 * Implemented as a one-page shim through the SAME `buildMarkdown` rather than a bespoke serializer, on
 * purpose: the shim inherits the edited-text preference and the figure inlining for free, so this can
 * never drift from what the full export produces. A second export path that formats a page slightly
 * differently is exactly the kind of quiet inconsistency this project is about.
 */
export function exportPageMarkdown(doc: DocFile, page: OcrPage): void {
  const label = `${stem(doc.name)}-p${page.index + 1}`;
  const onePage: DocFile = {
    ...doc,
    name: `${label}.pdf`, // only feeds stem() for the filename
    result: doc.result ? { ...doc.result, pages: [page] } : doc.result,
  };
  save(new Blob([buildMarkdown(onePage)], { type: 'text/markdown' }), `${label}.md`);
}

/**
 * Print-to-PDF: the same HTML export in a hidden iframe, printed once its stylesheet and fonts
 * are in. The browser's dialog does the PDF — no rasterizing library, math stays vector text.
 */
export function printPdf(doc: DocFile): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const idoc = iframe.contentWindow!.document;
  idoc.open();
  idoc.write(buildHtml(doc));
  idoc.close();

  const done = () => {
    // Give the KaTeX stylesheet + fonts a beat; print with fallback fonts beats never printing.
    const win = iframe.contentWindow!;
    const fonts = (idoc as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    Promise.race([fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]).then(() => {
      win.focus();
      win.print();
      window.setTimeout(() => iframe.remove(), 1000);
    });
  };
  if (idoc.readyState === 'complete') done();
  else iframe.addEventListener('load', done);
}
