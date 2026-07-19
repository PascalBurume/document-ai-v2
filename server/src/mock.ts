import { createHash } from 'node:crypto';
import type { OcrRequestPayload, OcrRunResult } from './types.js';
import { parsePageRange } from './mistral.js';

/**
 * MOCK_OCR=1 returns a canned response in the real response shape, so the viewer,
 * the overlay and the two-way linking can be developed and verified with no API key
 * and no spend. It is not a simulation of OCR quality — only of the contract.
 */

const LOREM = [
  { type: 'title', text: 'Systèmes de deux équations du premier degré', bbox: [90, 80, 700, 120] },
  {
    type: 'text',
    text: 'A la veille d’une bataille, les effectifs de deux armées étaient entre eux comme 5 à 6 ; la première perd 14 000 hommes, la seconde 6 000.',
    bbox: [90, 150, 720, 230],
  },
  { type: 'equation', text: '$$\\frac{x}{y} = \\frac{5}{6}$$', bbox: [90, 250, 400, 300] },
  {
    type: 'table',
    text: '| Armée | Effectif |\n| --- | --- |\n| Première | 50 000 |\n| Seconde | 60 000 |',
    bbox: [90, 330, 500, 460],
  },
  { type: 'list', text: '- si $p = 9$, le système est indéterminé.\n- si $p \\neq 9$, le système est impossible.', bbox: [90, 480, 700, 550] },
  { type: 'footer', text: '48', bbox: [90, 950, 140, 975] },
];

function pageOf(index: number, includeImages: boolean, confidence: string | undefined) {
  const markdown = [
    `# ${LOREM[0].text}`,
    '',
    LOREM[1].text,
    '',
    LOREM[2].text,
    '',
    LOREM[3].text,
    '',
    LOREM[4].text,
    '',
    '![img-0.jpeg](img-0.jpeg)',
    '',
    LOREM[5].text,
  ].join('\n');

  const words =
    confidence === 'word'
      ? markdown
          .replace(/[#*|$\\-]/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .map((text, i) => ({ text, confidence: i % 7 === 0 ? 0.42 : i % 3 === 0 ? 0.83 : 0.98 }))
      : undefined;

  return {
    index,
    markdown,
    dimensions: { dpi: 200, width: 800, height: 1000 },
    blocks: LOREM.map((block, i) => ({
      type: block.type,
      text: block.text,
      confidence: 0.9 - i * 0.03,
      bbox: {
        top_left_x: block.bbox[0],
        top_left_y: block.bbox[1],
        bottom_right_x: block.bbox[2],
        bottom_right_y: block.bbox[3],
      },
    })),
    images: [
      {
        id: 'img-0.jpeg',
        top_left_x: 540,
        top_left_y: 600,
        bottom_right_x: 740,
        bottom_right_y: 800,
        image_base64: includeImages ? TINY_PNG : null,
      },
    ],
    ...(confidence === 'page' ? { confidence: 0.94 } : {}),
    ...(words ? { words } : {}),
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAT0lEQVR4nO3OMQEAAAgDINc/9DL' +
  'BbUJ4kAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAY0hAAB3jZbAgAAAABJRU5ErkJggg==';

/**
 * MOCK_OCR fixture for the vision "second opinion". Mirrors the real repo failure — the OCR text
 * carries accents the printed page does not, surfaced as a disagreement between two readings, never
 * a silent correction. The `ocr` tokens are chosen to appear in the LOREM page above, so the
 * offline demo also exercises the in-place `suspect-vision` underline, not just the panel list.
 */
export function mockVision() {
  return {
    matches: false,
    model: 'mock-vision',
    notes: [
      { ocr: 'armées', image: 'armees', kind: 'accent' },
      { ocr: 'étaient', image: 'etaient', kind: 'accent' },
    ],
  };
}

/**
 * Stub for the per-figure label investigator, returned under MOCK_OCR. Carries one representative
 * disagreement — the dropped "1" in a power of ten — so the flag path is exercised with no spend.
 */
export function mockFigureCheck() {
  return {
    ok: false,
    model: 'mock-vision',
    labels: ['pH', 'Vₑ', '10^{-1}', '10^{-2}', '10^{-3}', '1', '2', '3'],
    notes: [{ ocr: '0^{-3}', image: '10^{-3}', kind: 'exponent' }],
  };
}

/** Stub for the classify-only re-check: pretends every figure is a chart, so keyless demos are inert. */
export function mockFigureClass() {
  return { isChart: true, reason: '', model: 'stub-grok' };
}

/**
 * Stub critic. Deterministic per redraw image: first call reports 2 mismatches, the second 1
 * remaining, then faithful — so a keyless/mock run exercises the whole loop (retry included) AND
 * the visible-notes rendering. In-process state is fine for a dev fixture.
 */
const compareSeen = new Map<string, number>();
export function mockFigureCompare(redraw?: string) {
  const k = createHash('sha256').update(redraw ?? '').digest('hex');
  const n = (compareSeen.get(k) ?? 0) + 1;
  compareSeen.set(k, n);
  if (n === 1) {
    return {
      faithful: false,
      model: 'stub-grok',
      problems: [
        'La courbe atteint pH 12 au lieu de 14 en fin de dosage.',
        "La graduation « 18 » manque sur l'axe des volumes.",
      ],
      summary: 'Deux écarts de données entre la recréation et le scan. (fixture)',
    };
  }
  if (n === 2) {
    return {
      faithful: false,
      model: 'stub-grok',
      problems: ["La graduation « 18 » manque toujours sur l'axe des volumes."],
      summary: 'Un écart subsiste après la reprise. (fixture)',
    };
  }
  return { faithful: true, model: 'stub-grok', problems: [], summary: 'La recréation correspond au scan. (fixture)' };
}

/** Stub for "recover text from an image region": a small transcription with LaTeX, for keyless demos. */
export function mockFigureText() {
  return {
    model: 'mock-vision',
    markdown:
      '[schéma : montage burette + bécher]\n\n' +
      '$$CH_3COOH + NaOH \\longrightarrow CH_3COONa + H_2O$$\n\n' +
      "Au point équivalent (PE) : $N_bV_b = N_aV_a$, soit $V_b = 10$ ml. *(exemple — texte factice.)*",
  };
}

/**
 * Stub for the "redraw this figure" feature, returned when no XAI_API_KEY is set (or MOCK_OCR is
 * on). A titration-curve chart in the target style — clean axes, dashed reference lines, blue
 * curve, French labels — so the whole Convert view works with no key and no spend.
 */
export function mockFigure() {
  return {
    stub: true,
    model: 'stub-grok',
    caption: "Courbe de neutralisation : pH en fonction du volume V_E de NaOH ajouté (stub — figure d'exemple).",
    svg:
      '<svg viewBox="0 0 720 480" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="14">' +
      '<rect width="720" height="480" fill="#ffffff"/>' +
      '<line x1="70" y1="20" x2="70" y2="420" stroke="#9ca3af" stroke-width="1.5"/>' +
      '<line x1="70" y1="420" x2="690" y2="420" stroke="#9ca3af" stroke-width="1.5"/>' +
      '<text x="40" y="18" fill="#111827" font-weight="600">pH</text>' +
      '<text x="668" y="452" fill="#111827" font-weight="600">Vₑ</text>' +
      Array.from({ length: 14 }, (_, i) => {
        const y = 420 - ((i + 1) * 400) / 14.5;
        return `<text x="44" y="${(y + 5).toFixed(0)}" fill="#6b7280" font-size="12">${i + 1}</text>`;
      }).join('') +
      Array.from({ length: 10 }, (_, i) => {
        const x = 70 + ((i + 1) * 600) / 10.5;
        return `<text x="${(x - 6).toFixed(0)}" y="440" fill="#6b7280" font-size="12">${(i + 1) * 2}</text>`;
      }).join('') +
      '<line x1="70" y1="227" x2="690" y2="227" stroke="#9ca3af" stroke-width="1" stroke-dasharray="5 5"/>' +
      '<text x="640" y="220" fill="#374151">PE</text>' +
      '<line x1="356" y1="20" x2="356" y2="420" stroke="#9ca3af" stroke-width="1" stroke-dasharray="5 5"/>' +
      '<line x1="70" y1="34" x2="690" y2="34" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3 5"/>' +
      '<text x="470" y="58" fill="#1d4ed8">lim pH = 14, V_b → ∞</text>' +
      '<path d="M 90 414 C 220 408, 300 392, 340 340 C 352 316, 352 300, 356 227 C 360 154, 362 130, 376 106 C 420 60, 540 44, 680 40" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/>' +
      '<text x="250" y="470" fill="#374151">Volume de NaOH ajouté (ml)</text>' +
      '</svg>',
  };
}

export function mockRun(payload: OcrRequestPayload): OcrRunResult {
  const total = payload.source.pageCount ?? 1;
  const requested = parsePageRange(payload.config.pages) ?? range(total);
  const pages = requested
    .filter((index) => index < total) // never claim to have read a page the document doesn't have
    .slice(0, 20)
    .map((index) => pageOf(index, payload.config.extractImages, payload.config.confidence));

  return {
    raw: {
      pages,
      model: payload.config.model,
      usage_info: { pages_processed: pages.length, doc_size_bytes: 123456, total_tokens: 4821 },
      ...(payload.config.responseFormat
        ? { document_annotation: JSON.stringify({ name: 'Mock Document', note: 'MOCK_OCR is on.' }) }
        : {}),
    },
    warnings: ['MOCK_OCR is on — this response is a fixture, not a real OCR run.'],
    processingMs: 380,
    sentBody: { model: payload.config.model, mock: true },
  };
}

/** Fixture for the figure-explanation study aid — shape-true, obviously fake content. */
export function mockFigureExplain() {
  return {
    model: 'mock-vision',
    explanation:
      "**Ce que montre la figure** — Une courbe de titrage acide-base (exemple factice).\n\n" +
      "**Comment la lire** — 1. L'axe horizontal donne le volume $V_b$ versé. 2. L'axe vertical " +
      'donne le pH. 3. Le saut vertical marque le point équivalent.\n\n' +
      "**L'idée clé** — Au point équivalent, $N_aV_a = N_bV_b$.\n\n" +
      "**Piège fréquent** — Confondre le point équivalent avec pH $= 7$ : ce n'est vrai que pour " +
      'un titrage acide fort / base forte. *(Texte factice — mode MOCK.)*',
  };
}
