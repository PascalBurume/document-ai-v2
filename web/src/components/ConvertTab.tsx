import { useMemo, useState } from 'react';
import { figureFilename, renderConverted } from '../lib/convert';
import { collectRadicands } from '../lib/radicals';
import { checkedRedrawPatch, figureCropDataUri, redrawFigureChecked, shrinkImage, type RedrawStage } from '../lib/figure';
import { explainFigure, recoverFigureText, verifyFigure } from '../lib/vision';
import { periodicTableSvg } from '../lib/periodicTable';
import { epureFactsFr, epureFiguresFor, epureIrsFor } from '../lib/epureCatalog';
import type { Block, DocFile, OcrPage } from '../lib/types';

interface Props {
  doc: DocFile;
  page: OcrPage;
  blocks: Block[];
  onRedraw: (pageIndex: number, blockId: string, patch: Partial<Block>) => void;
  /** Open this figure's épure in the Épure tab. The 3D lives there — this row is the way in. */
  onEpure: (key: string) => void;
}

/**
 * The converted reading view of one page: serif column, typeset math, AI-redrawn figures where
 * one exists. Under it, a strip with one row per figure to request a redraw — deliberately
 * per-figure and on-demand (a 266-page book can hold hundreds of figures; a paid redraw happens
 * only when someone asks for that figure). Redraws attach to the block, so they persist with the
 * session and are reused by every export. The scan on the left stays the original to compare
 * against — this view is a presentation, not evidence.
 */
export function ConvertTab({ doc, page, blocks, onRedraw, onEpure }: Props) {
  const [busy, setBusy] = useState<{ id: string; stage: RedrawStage } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The épures on THIS page, by block — so a figure row knows whether it has a reconstruction and
  // which one to open, without asking the catalog once per row.
  const epuresByBlock = useMemo(() => {
    const map = new Map<string, ReturnType<typeof epureFiguresFor>>();
    for (const f of epureFiguresFor(doc)) {
      if (f.pageIndex !== page.index) continue;
      const list = map.get(f.blockId);
      if (list) list.push(f);
      else map.set(f.blockId, [f]);
    }
    return map;
  }, [doc, page.index]);

  // Mistral reports the same figure twice (extracted image + bbox block); one row per filename,
  // keeping whichever block carries the most — an existing redraw first, then the crop.
  const figures = useMemo(() => {
    const byFile = new Map<string, Block>();
    const score = (b: Block) => (b.redrawnSvg ? 3 : 0) + (b.redrawNotChart ? 2 : 0) + (b.imageBase64 ? 1 : 0);
    for (const b of blocks) {
      if (b.type !== 'image') continue;
      const file = figureFilename(b);
      const cur = byFile.get(file);
      if (!cur || score(b) > score(cur)) byFile.set(file, b);
    }
    return [...byFile.values()];
  }, [blocks]);
  // On screen, redrawn figures render SIDE BY SIDE with the scan crop (compare) — that's the point
  // of this view. Exports drop the scan and keep the clean redraw.
  // Document-wide vocabulary: a radical bared in this page's table is re-grouped from the explicit
  // `\sqrt{…}` the OCR produced for the same expression anywhere in the book. Memoized on the
  // result, not the page — it is the same set for every page.
  const radicands = useMemo(() => collectRadicands(doc.result?.pages ?? []), [doc.result]);
  const html = useMemo(() => renderConverted(page, { compare: true, radicands }), [page, radicands]);

  const run = async (block: Block) => {
    setBusy({ id: block.id, stage: 'drawing' });
    setErrors((e) => ({ ...e, [block.id]: '' }));
    try {
      const image = await figureCropDataUri(doc, page, block);
      // "Redraw again" on an existing real redraw must actually redraw — force bypasses the
      // server cache (billed, deliberately). A first redraw still benefits from the cache.
      const r = await redrawFigureChecked(image, page.markdown.slice(0, 2500), {
        force: Boolean(block.redrawnSvg && !block.redrawnStub),
        onStage: (stage) => setBusy({ id: block.id, stage }),
      });
      onRedraw(page.index, block.id, checkedRedrawPatch(r));
      if (!r.redraw.svg) {
        setErrors((e) => ({ ...e, [block.id]: `Nothing to draw here: ${r.redraw.reason || 'blank crop'}.` }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [block.id]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  /**
   * The investigator: an independent vision reading of this figure's labels, flagging where the
   * OCR disagrees with what the figure shows (a dropped digit in `10^{-3}`, a misread exponent).
   * Flags only — the result attaches to the block and renders under the figure as `[[VIS?]]`.
   */
  const check = async (block: Block) => {
    setChecking(block.id);
    setErrors((e) => ({ ...e, [block.id]: '' }));
    try {
      const image = await figureCropDataUri(doc, page, block);
      const r = await verifyFigure(image, page.markdown.slice(0, 2500));
      onRedraw(page.index, block.id, {
        labelNotes: r.notes,
        labelCheckModel: r.model,
        labelChecked: true,
      });
    } catch (err) {
      setErrors((e) => ({ ...e, [block.id]: (err as Error).message }));
    } finally {
      setChecking(null);
    }
  };

  /**
   * Recover text Mistral trapped in this image region. When a text-heavy area (equations, a reaction
   * block) is captured as a single image, its text is never transcribed — a hole in the page. A
   * vision reading of the crop returns that text as Markdown + LaTeX, attached to the block and shown
   * (labelled) under the figure. A recovery, not evidence: the OCR markdown is never edited.
   */
  const recover = async (block: Block) => {
    setRecovering(block.id);
    setErrors((e) => ({ ...e, [block.id]: '' }));
    try {
      const image = await figureCropDataUri(doc, page, block);
      const r = await recoverFigureText(image, page.markdown.slice(0, 2500));
      onRedraw(page.index, block.id, { recoveredText: r.markdown, recoveredModel: r.model });
      if (!r.markdown) setErrors((e) => ({ ...e, [block.id]: 'The reading found no recoverable text in this region.' }));
    } catch (err) {
      setErrors((e) => ({ ...e, [block.id]: (err as Error).message }));
    } finally {
      setRecovering(null);
    }
  };

  /**
   * Ask the teaching agent to explain this figure to a student. Subject-agnostic — a Monge épure,
   * a log curve, a titration montage — but when this figure HAS an exact reconstruction (the épure
   * IRs), the computed facts ride along so the model teaches from arithmetic, not from re-guessing
   * the drawing. The result is a labelled study aid on the block; never an inspection verdict.
   */
  const explain = async (block: Block) => {
    setExplaining(block.id);
    setErrors((e) => ({ ...e, [block.id]: '' }));
    try {
      const image = await shrinkImage(await figureCropDataUri(doc, page, block));
      const facts = epureIrsFor(doc, page.index, block.id).map(epureFactsFr).filter(Boolean).join('\n\n');
      const r = await explainFigure(image, page.markdown.slice(0, 2500), facts || undefined);
      if (r.explanation) {
        onRedraw(page.index, block.id, { explanation: r.explanation, explainModel: r.model });
      } else {
        setErrors((e) => ({ ...e, [block.id]: "Le modèle n'a pas produit d'explication exploitable — réessayez." }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [block.id]: (err as Error).message }));
    } finally {
      setExplaining(null);
    }
  };

  /**
   * Insert / remove an EXACT, coloured periodic table on this page — for page 179's black-and-white
   * « Tableau périodique », which Mistral captured as garbled markup (no image figure to attach to).
   * An AI redraw of a reference this dense would invent wrong atomic masses, so it is authored from
   * canonical data instead. Attached to the page's first block (renderConverted prepends it above the
   * OCR); not an AI call and not billed; marked canonical so the redraw batch never overwrites it.
   */
  const canonicalBlock = blocks.find((b) => b.redrawnCanonical);
  const togglePeriodicTable = () => {
    if (canonicalBlock) {
      onRedraw(page.index, canonicalBlock.id, {
        redrawnCanonical: false,
        redrawnSvg: '',
        redrawnCaption: '',
        redrawnModel: undefined,
      });
    } else if (blocks[0]) {
      onRedraw(page.index, blocks[0].id, {
        redrawnSvg: periodicTableSvg(),
        redrawnCaption: 'Tableau périodique des éléments — référence exacte, en couleur',
        redrawnModel: 'reference',
        redrawnStub: false,
        redrawNotChart: false,
        redrawnCanonical: true,
      });
    }
  };

  return (
    <div className="convert pad">
      <div className="convert-tools">
        <button
          className={`btn tiny${canonicalBlock ? ' cached' : ''}`}
          onClick={togglePeriodicTable}
          title="Insert an accurate, coloured periodic table (canonical data — not an AI redraw of the scan). Use on the « Tableau périodique » page."
        >
          {canonicalBlock ? '✓ Tableau périodique inséré — retirer' : '⊞ Insérer le tableau périodique'}
        </button>
      </div>

      {/* eslint-disable-next-line react/no-danger -- output of our own renderer + sanitized SVG */}
      <div className="convert-doc" dangerouslySetInnerHTML={{ __html: html }} />

      {figures.length > 0 && (
        <div className="convert-figures">
          <p className="note">
            {figures.length} figure{figures.length === 1 ? '' : 's'} on this page. A redraw asks a vision model to
            recreate the chart as clean SVG; once done it appears above, side by side with the scan so you can
            compare. Generated content, always labelled — never a substitute for the scan.
          </p>
          <ul className="figure-list">
            {figures.map((block) => (
              <li key={block.id} className="figure-row">
                {/* The redrawn figure is shown in the document above (next to the scan), so the row
                    only carries a thumbnail while it's still just the original crop. */}
                {!block.redrawnSvg &&
                  (block.imageBase64 ? (
                    <img className="figure-thumb" src={asDataUri(block.imageBase64)} alt={block.text} />
                  ) : (
                    <span className="figure-thumb empty" title="No crop extracted — the whole page is sent instead">
                      🖼
                    </span>
                  ))}
                <div className="figure-meta">
                  <code>{figureFilename(block) || block.id}</code>
                  {block.redrawnCanonical ? (
                    <span className="chip cached" title="Exact reference inserted — not an AI redraw">
                      référence · tableau périodique
                    </span>
                  ) : block.redrawnSvg ? (
                    <span className={`chip${block.redrawnStub ? '' : ' cached'}`}>
                      {block.redrawnStub ? 'stub redraw' : `redrawn · ${block.redrawnModel}`}
                    </span>
                  ) : block.redrawNotChart ? (
                    <span className="chip" title={block.redrawReason || 'Not a data chart — the scan is kept'}>
                      kept scan · not a chart
                    </span>
                  ) : (
                    <span className="muted">original crop</span>
                  )}
                  {block.redrawChecked &&
                    (block.redrawProblems && block.redrawProblems.length ? (
                      <span
                        className="chip flag"
                        title="A critic compared the redraw against the scan and still sees these mismatches — listed under the figure above"
                      >
                        ⚠ {block.redrawProblems.length} mismatch{block.redrawProblems.length === 1 ? '' : 'es'} vs scan
                      </span>
                    ) : (
                      <span className="chip cached" title="A critic compared the redraw against the scan and found the same data and labels">
                        ✓ redraw checked against scan
                      </span>
                    ))}
                  {block.labelChecked &&
                    (block.labelNotes && block.labelNotes.length ? (
                      <span className="chip flag" title="A vision reading disagrees with the OCR — see the figure above">
                        ⚠ {block.labelNotes.length} label{block.labelNotes.length === 1 ? '' : 's'} flagged
                      </span>
                    ) : (
                      <span className="chip cached" title="A vision reading of the labels agrees with the OCR">
                        ✓ labels checked
                      </span>
                    ))}
                  {block.recoveredText && (
                    <span className="chip cached" title="Text trapped in this image was recovered — shown under the figure">
                      ✓ text recovered
                    </span>
                  )}
                  {block.explanation && (
                    <span className="chip cached" title="Une explication pédagogique est affichée sous la figure">
                      🎓 expliquée
                    </span>
                  )}
                  {errors[block.id] && <span className="vision-err">{errors[block.id]}</span>}
                </div>
                {epuresByBlock.get(block.id)?.[0] && (
                  <button
                    className="btn tiny ghost"
                    onClick={() => onEpure(epuresByBlock.get(block.id)![0].key)}
                    title="Reconstruction 3D calculée depuis la lecture manuelle de l'épure — géométrie déterministe, aucun appel modèle"
                  >
                    ⬡ Voir en 3D
                  </button>
                )}
                <button
                  className="btn tiny ghost"
                  onClick={() => void explain(block)}
                  disabled={explaining !== null}
                  title="Demander à un modèle d'expliquer cette figure à un élève — aide à l'étude étiquetée, jamais une correction. Pour une épure, la géométrie calculée est fournie au modèle."
                >
                  {explaining === block.id ? 'Explication…' : block.explanation ? '↻ Expliquer' : '🎓 Expliquer'}
                </button>
                <button
                  className="btn tiny ghost"
                  onClick={() => void recover(block)}
                  disabled={recovering !== null}
                  title="The OCR pass may have captured text (equations, labels) as a picture. Read it back with OpenAI vision."
                >
                  {recovering === block.id ? 'Reading…' : block.recoveredText ? '↻ Recover text' : '⧉ Recover text'}
                </button>
                <button
                  className="btn tiny ghost"
                  onClick={() => void check(block)}
                  disabled={checking !== null}
                  title="Read this figure's labels with a vision model and flag where the OCR disagrees"
                >
                  {checking === block.id ? 'Checking…' : block.labelChecked ? '↻ Check labels' : '⧉ Check labels'}
                </button>
                <button
                  className="btn tiny ghost"
                  onClick={() => void run(block)}
                  disabled={busy !== null}
                  title={
                    block.redrawnSvg && !block.redrawnStub
                      ? 'Re-draws this figure with a critic pass — up to 3 billed vision calls (redraw, compare, retry). The cache is deliberately bypassed.'
                      : 'Recreate this figure as SVG, then have a critic compare it against the scan (up to 3 vision calls).'
                  }
                >
                  {busy?.id === block.id
                    ? { drawing: 'Drawing…', checking: 'Checking…', retrying: 'Retrying…' }[busy.stage]
                    : block.redrawnSvg
                      ? '↻ Redraw again'
                      : '✦ Redraw as diagram'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  );
}

function asDataUri(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
}
