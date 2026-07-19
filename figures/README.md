# Hand-drawn figures

Source SVGs for books whose figures are redrawn by hand instead of by the vision model.
`web/src/lib/figures/*.ts` is **generated** from these — edit the SVG, then re-run:

```bash
node scripts/build-authored-figures.mjs figures/dessin-scientifique
```

## Why by hand

The `/api/figure` redraw prompts a vision model for a *chemistry* textbook and reasons in chart
semantics. Pointed at `dessin-scientifique` (Muselu, *Exercices de géométrie descriptive*, 51 pages,
62 figures) it produced confident nonsense — one cached redraw called a Monge projection an
"energy diagram", another invented axis ticks for an épure.

That is not a prompt bug. A dense épure is a **fabrication** problem, not a drawing problem: every
point position carries meaning, so a model redrawing freehand invents geometry that reads as
correct and is not. The same trap this repo exists to catch, one level up.

## How these were made, and what that buys

Each figure was cropped from the PDF at its OCR bbox, rotated upright, and overlaid with a
**coordinate grid in the SVG's own viewBox units** — so every point was *measured off the scan*,
not eyeballed — then checked against a **potrace of the page's own ink**, which cannot lie about
where a point is. Each SVG was rendered and compared against the scan until it matched.

They are still **reconstructions, not evidence.** So:

- the UI shows each one **beside the original crop**, badged *"redessinée à la main"* — never
  presented as the document;
- anything the author could not read is listed in `omissions` and **shown with the figure**,
  rather than guessed into place. Several dense plates (10, 13, 18, 19, 29, 32, 33, 35, 37, 47,
  48, 53, 60) carry 15–25 faint construction traces that were **left out on purpose**. Those
  figures are honest about being incomplete, which is the only acceptable way to be incomplete;
- `figures.json` records a confidence per figure. Treat `low` as "check it against the scan".

Keyed `page:blockId`, so a drawing can only ever land on the block it was drawn from.

## The scan stays the archive

Nothing here replaces `raw_text` or the page image. If a drawing and the scan disagree, **the scan
is right and the drawing is a bug** — that direction never reverses.
