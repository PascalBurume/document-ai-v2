import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml, buildMarkdown, buildPdf, renderConverted, sanitizeSvg } from './convert';
import type { Block, DocFile, OcrPage } from './types';

const bbox = { x: 0, y: 0, w: 10, h: 10 };

const figureBlock = (over: Partial<Block> = {}): Block => ({
  id: 'p0-i0',
  type: 'image',
  bbox,
  text: 'img-0.jpeg',
  imageBase64: 'AAAA',
  ...over,
});

const page = (markdown: string, blocks: Block[], index = 0): OcrPage => ({
  index,
  markdown,
  width: 800,
  height: 1000,
  blocks,
  words: [],
});

const doc = (pages: OcrPage[]): DocFile =>
  ({
    id: 'doc-0',
    name: 'chimie.pdf',
    sizeBytes: 1,
    mime: 'application/pdf',
    sourceType: 'document_url',
    dataUri: 'data:application/pdf;base64,x',
    pageCount: pages.length,
    result: { pages } as DocFile['result'],
  }) as DocFile;

/**
 * A correction is only worth making if it survives to the download. If these regress, the user exports
 * a document that quietly still says whatever the OCR guessed — the exact failure this repo exists for.
 */
const editedPage = (): OcrPage => ({
  ...page("# La matiere\n\nL'eau est composee. Formule $H_2O$.\n", []),
  editedMarkdown: "# La matière CORRECTED\n\nL'eau est composée. Formule $H_2O$.\n",
});

test('export: the HTML download carries the human correction, not the stale OCR', () => {
  const html = buildHtml(doc([editedPage()]));
  assert.match(html, /CORRECTED/);
  assert.match(html, /matière/);
  assert.doesNotMatch(html, /La matiere/, 'the superseded OCR text must not be exported');
  assert.match(html, /katex/, 'and the formula still typesets');
});

test('export: the Markdown download carries the correction, formula byte-exact', () => {
  const md = buildMarkdown(doc([editedPage()]));
  assert.match(md, /CORRECTED/);
  assert.doesNotMatch(md, /La matiere/);
  assert.ok(md.includes('$H_2O$'), 'the untouched formula round-trips into the export verbatim');
});

test('export: an unedited page still exports exactly its OCR text', () => {
  const md = buildMarkdown(doc([page('# La matiere\n\nrien.\n', [])]));
  assert.match(md, /La matiere/, 'no edit means nothing changes');
});

test('export: "this page" yields only that page, carrying its correction', () => {
  // `exportPageMarkdown` is a one-page shim over buildMarkdown; assert the shim itself, since save()
  // is a browser API. If this ever diverges from the full export, that's the bug worth catching.
  const p0 = page('# page one\n', [], 0);
  const p1 = { ...page('# page two OCR\n', [], 1), editedMarkdown: '# page two FIXED\n' };
  const whole = doc([p0, p1]);
  const onePage = buildMarkdown({ ...whole, result: { ...whole.result!, pages: [p1] } } as DocFile);

  assert.match(onePage, /page two FIXED/, 'the correction comes along');
  assert.doesNotMatch(onePage, /page one/, 'other pages are not in a single-page export');
  assert.doesNotMatch(onePage, /page two OCR/, 'the superseded OCR text is not exported');
  assert.match(onePage, /<!-- page 2 -->/, 'and it keeps its real page anchor, not a renumbered one');
});

test('PDF export survives French accents and descriptive-geometry Unicode', async () => {
  const bytes = await buildPdf(doc([page('Épure πᴴ → πⱽ : α ⊥ β, vraie grandeur √2.', [])]));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.ok(bytes.length > 500, 'the result contains a real PDF document, not an empty download');
});

test('converted table restores source-matched curve figures omitted by OCR', () => {
  const table = [
    '| Condition | Courbe | Nature |',
    '| --- | --- | --- |',
    '| 1 | tangentes obliques | anguleux |',
    '| 2 | tangente verticale | inflexion |',
  ].join('\n');
  const block: Block = {
    id: 'p318-b1', type: 'table', bbox, text: table,
    authoredTableFigures: [
      '<svg viewBox="0 0 10 10"><path d="M0 9L5 2L10 9"/></svg>',
      '<svg viewBox="0 0 10 10"><path d="M5 0V10"/></svg>',
    ],
  };
  const html = renderConverted(page(table, [block], 318));
  assert.equal((html.match(/authored-table-curve/g) ?? []).length, 2);
  assert.match(html, /Schéma reconstruit d’après le scan/);
  assert.doesNotMatch(html, /TABLEFIG:/, 'every presentation token is replaced by its SVG');
});

test('sanitize: scripts, foreignObject, handlers and external refs are stripped; #refs survive', () => {
  const dirty =
    '<svg viewBox="0 0 10 10"><script>alert(1)</script>' +
    '<foreignObject><body>x</body></foreignObject>' +
    '<circle onclick="steal()" r="4"/>' +
    '<use href="https://evil.example/x.svg#p"/><use href="#local"/></svg>';
  const clean = sanitizeSvg(dirty);
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('foreignObject'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('evil.example'));
  assert.ok(clean.includes('href="#local"'));
});

test('sanitize: prose around the svg and a missing svg tag return only the svg / nothing', () => {
  assert.ok(sanitizeSvg('Here you go: <svg><rect/></svg> hope it helps').startsWith('<svg'));
  assert.equal(sanitizeSvg('no svg here'), '');
  assert.equal(sanitizeSvg(''), '');
});

test('converted page: a redrawn figure replaces its image ref, labelled as AI', () => {
  const p = page('Before\n\n![img-0.jpeg](img-0.jpeg)\n\nAfter $x^2$', [
    figureBlock({ redrawnSvg: '<svg viewBox="0 0 720 480"><path d="M0 0"/></svg>', redrawnModel: 'gpt-5.6' }),
  ]);
  const html = renderConverted(p);
  assert.ok(html.includes('class="ai-figure"'));
  assert.ok(html.includes('viewBox="0 0 720 480"'));
  assert.ok(html.includes('recreated by AI'));
  assert.ok(!html.includes('img-0.jpeg'), 'the original ref is fully replaced');
  assert.ok(html.includes('katex'), 'math still typesets');
});

test('converted page: a bbox image block whose text is the full ![ref](file) still substitutes', () => {
  // Mistral reports figures twice: extracted image (text = "img-0.jpeg") and a bbox block whose
  // text is the raw markdown ref. A redraw on the bbox variant must still find its place.
  const p = page('![img-0.jpeg](img-0.jpeg)', [
    figureBlock({
      id: 'p0-b5',
      text: '![img-0.jpeg](img-0.jpeg)',
      imageBase64: undefined,
      redrawnSvg: '<svg><rect/></svg>',
      redrawnModel: 'gpt-5.6',
    }),
  ]);
  const html = renderConverted(p);
  assert.ok(html.includes('class="ai-figure"'));
  assert.ok(!html.includes('img-ref'), 'no unresolved-image chip remains');
});

test('converted page (compare): the scan crop renders side by side with the AI redraw', () => {
  const p = page('![img-0.jpeg](img-0.jpeg)', [
    figureBlock({ redrawnSvg: '<svg viewBox="0 0 720 480"><path d="M0 0"/></svg>', redrawnModel: 'gpt-5.6' }),
  ]);
  const html = renderConverted(p, { compare: true });
  assert.ok(html.includes('fig-pair'), 'two-column comparison');
  assert.ok(html.includes('Original — scan'));
  assert.ok(html.includes('data:image/jpeg;base64,AAAA'), 'original crop is shown');
  assert.ok(html.includes('viewBox="0 0 720 480"'), 'redraw is shown');
  assert.ok(html.includes('recreated by AI'));
});

test('exports keep the clean redraw, not the scan-vs-redraw comparison', () => {
  const d = doc([page('![img-0.jpeg](img-0.jpeg)', [figureBlock({ redrawnSvg: '<svg><rect/></svg>', redrawnModel: 'gpt-5.6' })])]);
  const html = buildHtml(d);
  assert.ok(!html.includes('fig-pair'), 'no side-by-side in the exported artifact');
  assert.ok(!html.includes('base64,AAAA'), 'the scan crop is not embedded in the export');
  assert.ok(html.includes('ai-figure'), 'the clean redraw is still there');
});

test('converted page: without a redraw the original crop renders, exactly as the Text tab', () => {
  const p = page('![img-0.jpeg](img-0.jpeg)', [figureBlock()]);
  const html = renderConverted(p);
  assert.ok(html.includes('data:image/jpeg;base64,AAAA'));
  assert.ok(!html.includes('ai-figure'));
});

test('converted page: a stub redraw says it is a stub, never a real AI redraw', () => {
  const p = page('![img-0.jpeg](img-0.jpeg)', [
    figureBlock({ redrawnSvg: '<svg><rect/></svg>', redrawnStub: true, redrawnModel: 'stub-openai' }),
  ]);
  const html = renderConverted(p);
  assert.ok(html.includes('Stub example'));
  assert.ok(!html.includes('recreated by AI'));
});

test('markdown export: redrawn figures inline as labelled <figure>, others keep their ref', () => {
  const d = doc([
    page('![img-0.jpeg](img-0.jpeg)', [figureBlock({ redrawnSvg: '<svg><rect/></svg>', redrawnModel: 'gpt-5.6' })]),
    page('![img-1.jpeg](img-1.jpeg)', [figureBlock({ id: 'p1-i0', text: 'img-1.jpeg' })], 1),
  ]);
  const md = buildMarkdown(d);
  assert.ok(md.includes('<figure class="ai-figure">'));
  assert.ok(md.includes('![img-1.jpeg](img-1.jpeg)'), 'non-redrawn figure is not silently dropped');
  assert.ok(md.includes('<!-- page 1 -->') && md.includes('<!-- page 2 -->'));
});

test('html export: one self-contained document — doctype, pinned katex css, no scripts', () => {
  const d = doc([page('# Titre\n\n$\\frac{1}{2}$', [])]);
  const html = buildHtml(d);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('katex@0.16.11/dist/katex.min.css'));
  assert.ok(html.includes('class="page-no"'));
  assert.ok(!html.includes('<script'), 'math is pre-rendered; the export carries no JavaScript');
});

/**
 * The critic's remaining mismatches are FLAGS on the recreation — they must render visibly (and
 * escaped), travel into exports like the label flags do, and never appear when there is nothing
 * to say. The model's reading is checking-view material only.
 */
test('critic notes render under the figure, escaped, with the [[FIG?]] badge', () => {
  const p = page('![img-0.jpeg](img-0.jpeg)', [
    figureBlock({
      redrawnSvg: '<svg viewBox="0 0 720 480"><path d="M0 0"/></svg>',
      redrawnModel: 'gpt-5.6',
      redrawChecked: true,
      redrawFaithful: false,
      redrawProblems: ['La courbe monte au lieu de descendre <b>é'],
      redrawCheckModel: 'gpt-5.6',
    }),
  ]);
  const html = renderConverted(p, { compare: true });
  assert.ok(html.includes('fig-critic'));
  assert.ok(html.includes('[[FIG?]]'));
  assert.ok(html.includes('&lt;b&gt;é'), 'problem text is HTML-escaped');
  assert.ok(!html.includes('<b>é'), 'never injected raw');
});

test('critic notes travel into the export; the model reading does not', () => {
  const block = figureBlock({
    redrawnSvg: '<svg viewBox="0 0 720 480"><rect/></svg>',
    redrawnModel: 'gpt-5.6',
    redrawChecked: true,
    redrawFaithful: false,
    redrawProblems: ['La graduation 18 manque.'],
    redrawReading: 'x: V 0-20 ml; y: pH 0-14; mapping: …',
  });
  const compare = renderConverted(page('![img-0.jpeg](img-0.jpeg)', [block]), { compare: true });
  assert.ok(compare.includes('fig-reading'), 'the reading shows in the checking view');
  assert.ok(compare.includes('prétend encoder'));

  const exported = buildHtml(doc([page('![img-0.jpeg](img-0.jpeg)', [block])]));
  assert.ok(exported.includes('fig-critic'), 'unresolved mismatches travel with the document');
  assert.ok(exported.includes('La graduation 18 manque.'));
  assert.ok(!exported.includes('fig-reading'), 'the working stays in the checking view');
});

test('a checked, faithful figure carries no critic markup — clean is silent', () => {
  const p = page('![img-0.jpeg](img-0.jpeg)', [
    figureBlock({
      redrawnSvg: '<svg viewBox="0 0 720 480"><rect/></svg>',
      redrawnModel: 'gpt-5.6',
      redrawChecked: true,
      redrawFaithful: true,
      redrawProblems: [],
    }),
  ]);
  const html = renderConverted(p, { compare: true });
  assert.ok(!html.includes('fig-critic'));
});

/**
 * A blanket `svg { max-width:100%; height:auto }` in the export CSS is invisible in review and
 * catastrophic in the artifact: KaTeX draws a radical as an SVG ~400em wide that its container
 * clips, so constraining it collapses the surd to ~0.05px tall. `√(2x+5) > x-5` then exports as
 * ` 2x+5 > x-5` — a formula that reads as a plausible transcription of a DIFFERENT inequality.
 * Exactly the "fluent, plausible, wrong" failure this repo exists to catch, produced by a
 * stylesheet. So the export's figure sizing must never match a KaTeX SVG.
 */
test('export CSS never applies figure sizing to KaTeX SVGs (the vanishing radical)', () => {
  const html = buildHtml(doc([page('$$\\sqrt{2x+5} > x-5$$', [])]));
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

  for (const rule of css.split('}')) {
    const brace = rule.indexOf('{');
    if (brace < 0) continue;
    const body = rule.slice(brace + 1);
    // Only rules that constrain geometry can flatten a radical.
    if (!/height\s*:\s*auto|max-width|width\s*:/.test(body)) continue;

    for (const selector of rule.slice(0, brace).split(',')) {
      const s = selector.trim();
      if (!/\bsvg$/.test(s)) continue; // the rule's subject is an <svg>
      if (s.includes('.katex')) continue; // deliberately about KaTeX's own geometry
      assert.ok(
        />\s*svg$/.test(s),
        `"${s}" sizes every descendant <svg>, including KaTeX's radical — use a child combinator`,
      );
    }
  }
});

test('the exported book still typesets the radical it was given', () => {
  const html = buildHtml(doc([page('$$\\sqrt{2x+5} > x-5$$', [])]));
  assert.ok(html.includes('katex'), 'the formula is typeset, not left as source');
  assert.ok(html.includes('sqrt'), 'and the radical survives into the artifact');
});

/**
 * The teaching note is a STUDY AID: it must always render clearly labelled as AI material, it must
 * show even for a figure that was never redrawn (the scan stays, the note attaches under it), and
 * exports must carry it — a student reading the exported book gets the same help as in the app.
 */
test('explanation: renders labelled under a redrawn figure, with LaTeX typeset', () => {
  const b: Block = {
    id: 'b1', type: 'image', text: 'img-0.jpeg', bbox: { x: 0, y: 0, w: 1, h: 1 },
    redrawnSvg: '<svg viewBox="0 0 10 10"></svg>', redrawnModel: 'gpt-5.6',
    explanation: "**L'idée clé** — au point équivalent $N_aV_a = N_bV_b$.",
    explainModel: 'gpt-5.6',
  } as Block;
  const html = renderConverted(page('![img-0.jpeg](img-0.jpeg)', [b]));
  assert.ok(html.includes('ai-explain'));
  assert.ok(html.includes('explication IA'));
  assert.ok(html.includes('Aide à l&#39;étude') || html.includes("Aide à l'étude"));
  assert.ok(html.includes('katex')); // the note's LaTeX is typeset like everything else
});

test('explanation: a never-redrawn figure keeps its scan and still shows the note; exports carry it', () => {
  const b: Block = {
    id: 'b1', type: 'image', text: 'img-0.jpeg', bbox: { x: 0, y: 0, w: 1, h: 1 },
    imageBase64: 'data:image/jpeg;base64,xx',
    explanation: 'Comment lire la figure, pas à pas.',
    explainModel: 'gpt-5.6',
  } as Block;
  const p = page('![img-0.jpeg](img-0.jpeg)', [b]);
  const html = renderConverted(p);
  assert.ok(html.includes('ai-figure kept')); // scan kept, nothing fabricated
  assert.ok(html.includes('Comment lire la figure'));
  const exported = buildHtml(doc([p]));
  assert.ok(exported.includes('Comment lire la figure'));
  assert.ok(exported.includes('.ai-explain')); // the export stylesheet knows the box
});

test('explanation: an AUTHORED figure (the épures) shows the note too — the branch that missed it live', () => {
  const b: Block = {
    id: 'b1', type: 'image', text: 'img-0.jpeg', bbox: { x: 0, y: 0, w: 1, h: 1 },
    redrawnSvg: '<svg viewBox="0 0 10 10"></svg>', redrawnAuthored: true, redrawnModel: 'authored',
    explanation: 'La charnière est l’axe de rotation du rabattement.',
  } as Block;
  const p = page('![img-0.jpeg](img-0.jpeg)', [b]);
  for (const compare of [true, false]) {
    const html = renderConverted(p, { compare });
    assert.ok(html.includes('La charnière est'), `compare=${compare}`);
  }
});
