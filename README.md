# Document AI — Mistral OCR playground

A thin, flexible UI over Mistral's OCR REST API: upload a document, run OCR, inspect the
result down to the word. The API key lives on the server and never reaches the browser.

**Something broken? Read [RUNBOOK.md](RUNBOOK.md) first** — every failure hit while building
this is in there with its diagnosis ("fetch failed" on large PDFs, missing key, dead ports,
a shimmering canvas, a feature that silently does nothing).

```
server/   Express + TypeScript. Holds MISTRAL_API_KEY, calls POST /v1/ocr, Files API for large uploads.
web/      Vite + React + TypeScript. Two-pane viewer, config panel, JSON-Schema builder.
```

## Run

```bash
cp .env.example .env      # add your MISTRAL_API_KEY
npm install
npm run dev               # server :8787, web :5174
```

Open http://localhost:5174, drop a PDF or image, press ⌘/Ctrl + Enter.

**No key? `MOCK_OCR=1 npm run dev`** returns a fixture in the real response shape. The whole
viewer — overlay, two-way linking, tabs, confidence, tables — works offline, with no spend.

## What each control does

| Control | Where it goes |
|---|---|
| Model | `model` |
| Pages (`1-4,8`) | `pages`, converted from 1-based UI to the API's 0-based list |
| Extract → Images | `include_image_base64` |
| Extract → Header / Footer | client-side filter on regions of that type |
| Extract bounding boxes | `include_blocks` |
| Extract tables | client-side transform of the returned markdown |
| Confidence scores | `confidence_scores` |
| Annotate images | `bbox_annotation_format` (JSON Schema) |
| Response format | `document_annotation_format` (your JSON Schema; the annotation prompt rides along as the schema's `description`, which is how Mistral reads extraction instructions) |

### Two of these are not in the published API schema — and one of them doesn't work

`include_blocks` and `confidence_scores` are exposed by the playground but absent from
Mistral's documented request body. The server sends them anyway; if the API rejects the body
it strips **only the field the error actually names** and retries once, and the run comes back
with a warning chip. Verified against the live API (July 2026):

| Field | Status |
|---|---|
| `include_blocks` | **Works.** Bounding boxes are real; every overlay box came from the API. |
| `confidence_scores` | **Rejected** — 422 `extra_forbidden`. The Confidence dropdown's Word/Page options therefore have no effect. The UI says so ("this response carried no per-word scores") rather than inventing a number. |

The retry is deliberately surgical. An earlier version stripped every speculative field
whenever any one was rejected, which reported `include_blocks` as broken when only
`confidence_scores` was — a warning that lies is worse than no warning.

### The model silently repairs text — unpredictably

`test-chimie.pdf` is printed entirely without accents. Measured against the live API:

| | Scan says | Mistral returns |
|---|---|---|
| p.1 | `composee`, `hydrogene`, `d'oxygene` | `composée`, `hydrogène`, `d'oxygène` — **invented** |
| p.1 | `matiere` | `matiere` — untouched, in the same heading |
| p.2 | `melanges`, `homogene`, `reaction` | all three untouched |

So it corrects French spelling on some words, on some pages, and nothing in the response says
which. A consistent bias could be corrected for; this cannot. The markdown is a **claim about**
the document, not evidence of it.

This is the whole reason Relire's Review tab exists. The Document AI tab is an inspector, not
a substitute for verification — which is why it was added alongside Review rather than
replacing it.

Table mode and the header/footer chips are deliberately **client-side**: both are things we can
do deterministically on the returned markdown, so guessing at an undocumented request field
would only add a way to fail.

## The viewer

Left pane renders the page with pdf.js and overlays one colored, type-tagged box per region.
Right pane has three tabs over the same page:

- **Text** — rendered prose, equations typeset with KaTeX. With confidence set to Word, this
  becomes a word stream tinted by score (darker = less certain, hover for the value).
- **Visual** — the region inventory: type, coordinates, extracted text, image annotations, Copy.
- **Markdown** — the raw source, one card per block, each with Copy.

Hovering or selecting a box highlights the matching span, and vice-versa. The API returns no
character offsets, so blocks are located by **matching their text back into the page markdown**
(`linkBlocks` in `web/src/lib/ocr.ts`). A block whose text doesn't match stays unlinked — its box
still works, it just doesn't highlight a span. That's the one soft spot in the two-way link.

`⌘/Ctrl+Enter` run · `←/→` page · `+/-` zoom · `f` fit to width · `Esc` deselect.

## Épures in 3D — computed, never asserted

For the *dessin scientifique* geometry book, figures with a hand-authored reading get a
**⬡ Voir en 3D** button in the Convert tab. A descriptive-geometry épure is an exact double
projection: once the figure is *read* (which points, which hinge, in pixels), its 3D shape is
fully determined by closed-form arithmetic — so the viewer shows geometry, not a guess, and no
model is involved anywhere in the path.

The reading lives in `figures/dessin-scientifique/ir/*.json` (one Intermediate Representation
per sub-figure; `status.json` is the worklist of what remains). `npm run build:epure-ir`
validates each IR, refuses one bound to the wrong page/block, and generates
`web/src/lib/figures/dessinScientifiqueIr.ts`. The deterministic half is
`web/src/lib/epureReconstruct.ts`; its output is checked in tests against the rabattu positions
the book's own author constructed with a compass (`epureGold.test.ts`) — when the math and the
1988 plate agree to a few pixels, both readings are probably right. Writing a new IR by hand is
assisted by `node scripts/digest-epure-svg.mjs <authored svg>`.

## Figure explanations — a study aid, not a verdict

Every figure row in the Convert tab has **🎓 Expliquer**: a vision model explains the figure to
a student in French — what it shows, how to read it step by step, the key concept, the classic
mistake. Works across the books' subjects (an épure, a log curve, an ionic-bond diagram). For
figures that have an épure IR, the reconstruction's exact numbers (fold angle, true lengths,
cotes/éloignements) ride along in the prompt, so the model teaches from arithmetic instead of
re-guessing the drawing. The note renders in a green box under the figure (Convert, Book, and
exports), always labelled as AI teaching material — it never grades the OCR and is a different
register from the amber inspection flags. Grok first, Mistral vision as automatic fallback when
the xAI account is dry; results disk-cache as `exp-<sha>.json`, so an explanation is paid once.

## Nothing you have processed has to be processed twice

Three layers, each catching what the one above it misses:

| Layer | Where | Survives |
|---|---|---|
| Session | IndexedDB, one slot | Reload. Restores what you had open, no clicks. |
| **Library** | `.library/library.db` (SQLite), keyed by content hash | **Restart, a new session, a different browser, a different port.** |
| Response cache | `.cache/` on the server | Everything, plus a `.library/` you deleted. |

**Library** (`🗂 Processed` in the top bar, and the list under the dropzone) is every document
whose run finished, with its result, its redraws and its label checks. Reopening one costs no
upload and no API call — it replays what was already paid for. Restart deliberately does *not*
clear it: the button people press by reflex must not be able to throw away billed results.

Keyed by **content**, like the server cache and the edit store — so the same scan under a different
filename is the same entry, re-running replaces that entry rather than piling up a near-duplicate,
and a reopened document brings its hand-corrections with it. Bounded to 24 entries, oldest evicted
(`pickEvictions`, unit-tested — an eviction rule you have to infer from behaviour is a bug waiting
to happen). Paying again for a fresh reading stays a separate, deliberate act: **Force re-run**.

### The library is on the server, and that is not an implementation detail

It lived in IndexedDB until July 2026, and IndexedDB is scoped to an **origin**. This UI is served
from three (`:5174` standalone, `:5173` inside Relire, `:8787` built), so the library you filled on
one read *empty* on the next — while the paid run sat in `.cache/` and the corrections in `.edits/`,
keyed and intact. The home screen would report "2 pages hand-corrected" (read from the server)
directly above an empty document grid (read from that browser). Nothing was ever lost; it was
unreachable, which looks identical from the outside and is worse, because you go and pay again.

Storage that a change of URL, of browser, or of a cleared profile can hide is not storage. So:

- Metadata and bytes are **separate tables**. Listing the library never reads a PDF; you pay those
  bytes only for the entry you actually open.
- The bytes upload **once per document** (`needsBytes` in the PUT reply), never on the re-saves that
  a figure sweep fires — the same lesson the session checkpoint learned the hard way.
- `.library/` sits beside `.edits/`, **not** inside `.cache/`. A library entry carries figure
  redraws and recovered text: paid vision calls that a re-run does *not* reproduce. Irreplaceable
  data must never live in a directory whose whole contract is "safe to delete".
- Anything left in an old browser's IndexedDB is handed to the server on first load and only then
  dropped locally. Changing the storage engine must never be why someone's work disappears.

## Large files are split, not uploaded

Under 4 MB the file is inlined as a base64 data URI and sent in one request.

Above that it is **split client-side** (`web/src/lib/split.ts`): only the pages actually being
OCR'd are extracted and sent in ~2.5 MB chunks, whose results are stitched back together.

This is not premature optimisation — a single large upload does not reliably work:

```
20MB upload -> EPIPE          13MB upload -> ECONNRESET       20MB upload -> HTTP 200
```

Those are three attempts minutes apart. The connection is reset mid-upload, intermittently,
worse with size. It reproduces identically under Node's `fetch` **and under `curl`**, so it is
the network path to Mistral, not the client — retries with backoff do not rescue it. Sending a
few MB at a time does. A "pages 1-4" run of a 266-page book now uploads four pages.

The server still exposes the Files API path (`POST /api/files`) and retries socket errors, but
the split is what makes a large book work.

**The stitching is the dangerous part.** Page 0 of chunk 3 is not page 0 of the book; an
off-by-one there silently attributes every page's text to the wrong scan and nothing on screen
would look wrong. `remapPages` is therefore pure and unit-tested, including a case that chunks a
whole 100-page book and asserts every page appears exactly once, in order.

## Parsing

`parseOcrResponse` is defensive on purpose: bounding boxes are accepted as corner pairs,
`x/y/width/height`, or 4-tuples; block types are normalised to a known set with an `other`
fallback; confidences are accepted as 0-1 or 0-100. Anything unrecognised is dropped, not thrown.
The viewer is driven by `pages[].blocks` and `pages[].markdown`.
