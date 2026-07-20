/**
 * Diagnostic points overlaid, in RED, on a plate in the zoomable viewer — so you can SEE the exact
 * coordinates behind each figure's 3D fate. This is documentation of a reading, not a reconstruction.
 *
 * Exact and partial plates carry these: every usable projection is a solid red point; every absent
 * or incompatible coordinate is a cross/ring. A diagnostic marker documents the gap and feeds the
 * red 3D locus shown by the workspace; it never supplies an invented coordinate.
 *
 * COORDINATES ARE IN EACH PLATE'S OUTER viewBox FRAME — the frame SVGLoader bakes transforms into, and
 * the frame `EpurePlateViewer` maps to world. For a plate drawn under a root rotate, the reads are
 * transformed here to that outer frame (rotate(-90): (x,y)→(y,720−x); rotate(180): (x,y)→(720−x,1260−y)).
 */

export type DiagKind = 'found' | 'unpaired' | 'missing';

export interface PlateDiagPoint {
  /** e.g. « A^V », « B^H » — the projection this mark is. */
  label: string;
  x: number;
  y: number;
  /**
   * found    — V and H both drawn and share the recall line: a usable vertex (solid dot).
   * unpaired — V and H both drawn but off the recall line: a near-miss (hollow ring).
   * missing  — this projection is not on the plate; placed where it WOULD sit (a red ✕).
   */
  kind: DiagKind;
  note?: string;
}

/** Keyed `page:blockId` (0-based page, as `figureSetFor`). */
export const PLATE_DIAGNOSTICS: Record<string, PlateDiagPoint[]> = {
  // ── fig21 — triangle + centres. S₁/S₂/S′ have only a horizontal projection. ──
  '19:p19-b17': [
    { label: 'A^V', x: 100, y: 245, kind: 'found' },
    { label: 'A^H', x: 113, y: 620, kind: 'found' },
    { label: 'B^V', x: 305, y: 245, kind: 'found' },
    { label: 'B^H', x: 317, y: 705, kind: 'found' },
    { label: 'C^V', x: 655, y: 244, kind: 'found' },
    { label: 'C^H', x: 650, y: 460, kind: 'found' },
    { label: 'S^V', x: 188, y: 90, kind: 'found' },
    { label: 'S^H', x: 195, y: 468, kind: 'found' },
    { label: 'I^V', x: 353, y: 245, kind: 'found' },
    { label: 'I^H', x: 363, y: 672, kind: 'found' },
    { label: 'S₁^V', x: 30, y: 245, kind: 'missing', note: 'seule S₁^H est tracée' },
    { label: 'S₂^V', x: 547, y: 243, kind: 'missing', note: 'seule S₂^H est tracée' },
    { label: "S′^V", x: 327, y: 244, kind: 'missing', note: "projection verticale partenaire non identifiée" },
  ],
  // ── fig41 — trace α : pairs are construction reports, not common recalls. ──
  '31:p31-b1': [
    { label: 'A^V', x: 318, y: 246, kind: 'unpaired' },
    { label: 'A^H', x: 314, y: 937, kind: 'unpaired' },
    { label: 'B^V', x: 317, y: 460, kind: 'unpaired' },
    { label: 'B^H', x: 296, y: 850, kind: 'unpaired' },
    { label: 'C^V', x: 306, y: 589, kind: 'unpaired' },
    { label: 'C^H', x: 303, y: 723, kind: 'unpaired' },
    { label: 'D^V', x: 314, y: 374, kind: 'unpaired' },
    { label: 'D^H', x: 290, y: 1073, kind: 'unpaired' },
    { label: 'I^V', x: 296, y: 536, kind: 'unpaired' },
    { label: 'I^H', x: 299, y: 805, kind: 'unpaired' },
  ],
  // ── fig42 — trace β : all labelled pairs sit on an oblique construction trace. ──
  '31:p31-b4': [
    { label: 'A^V', x: 332, y: 142, kind: 'unpaired' },
    { label: 'A^H', x: 300, y: 788, kind: 'unpaired' },
    { label: 'B^V', x: 320, y: 377, kind: 'unpaired' },
    { label: 'B^H', x: 301, y: 610, kind: 'unpaired' },
    { label: 'C^V', x: 328, y: 236, kind: 'unpaired' },
    { label: 'C^H', x: 302, y: 504, kind: 'unpaired' },
    { label: 'D^V', x: 322, y: 329, kind: 'unpaired' },
    { label: 'D^H', x: 296, y: 715, kind: 'unpaired' },
    { label: 'I^V', x: 323, y: 317, kind: 'unpaired' },
    { label: 'I^H', x: 299, y: 652, kind: 'unpaired' },
  ],
  // ── fig45 — outer coordinates after the plate's rotate(-90). ──
  '32:p32-b9': [
    { label: 'P^V', x: 221, y: 303, kind: 'unpaired' },
    { label: 'P^H', x: 221, y: 487, kind: 'unpaired' },
    { label: 'Q^V', x: 221, y: 354, kind: 'unpaired' },
    { label: 'Q^H', x: 221, y: 447, kind: 'unpaired' },
    { label: 'A^V', x: 221, y: 154, kind: 'unpaired' },
    { label: 'A^H', x: 221, y: 416, kind: 'unpaired' },
    { label: 'B^V', x: 221, y: 258, kind: 'unpaired' },
    { label: 'B^H', x: 221, y: 560, kind: 'unpaired' },
  ],
  // ── fig46 — curves a/b: labelled intersections are reports without a common recall. ──
  '33:p33-b2': [
    { label: 'A^V', x: 401, y: 335, kind: 'unpaired' },
    { label: 'A^H', x: 394, y: 615, kind: 'unpaired' },
    { label: 'B^V', x: 400, y: 208, kind: 'unpaired' },
    { label: 'B^H', x: 400, y: 830, kind: 'unpaired' },
    { label: 'Q^V', x: 399, y: 240, kind: 'unpaired' },
    { label: 'Q^H', x: 400, y: 772, kind: 'unpaired' },
    { label: 'P^V', x: 396, y: 424, kind: 'unpaired' },
    { label: 'P^H', x: 385, y: 900, kind: 'unpaired' },
  ],
  // ── E 82 (fig32) — quadrilatère ABCD lifted to 3D. Outer frame 510×720 (rotate(-90) applied). ──
  '25:p25-b14': [
    { label: 'A^V', x: 182, y: 248, kind: 'found' },
    { label: 'A^H', x: 186, y: 543, kind: 'found' },
    { label: 'B^V', x: 236, y: 347, kind: 'found' },
    { label: 'B^H', x: 238, y: 407, kind: 'found' },
    { label: 'C^V', x: 353, y: 248, kind: 'found' },
    { label: 'C^H', x: 357, y: 473, kind: 'found' },
    { label: 'D^V', x: 289, y: 378, kind: 'found' },
    { label: 'D^H', x: 293, y: 543, kind: 'found' },
  ],
  // ── E 86 (fig35) — quadrilatère ABCD lifted to 3D. Frame 720×490. ──
  '28:p28-b0': [
    { label: 'A^V', x: 586, y: 253, kind: 'found' },
    { label: 'A^H', x: 116, y: 256, kind: 'found' },
    { label: 'B^V', x: 468, y: 252, kind: 'found', note: 'sommet le plus bruité (11px)' },
    { label: 'B^H', x: 300, y: 241, kind: 'found', note: 'sommet le plus bruité (11px)' },
    { label: 'C^V', x: 424, y: 76, kind: 'found' },
    { label: 'C^H', x: 267, y: 78, kind: 'found' },
    { label: 'D^V', x: 540, y: 82, kind: 'found' },
    { label: 'D^H', x: 109, y: 82, kind: 'found' },
  ],
  // ── E 87 (fig36) — hexagone ABCDEF lifted to 3D (noisy). Frame 720×550. ──
  '28:p28-b1': [
    { label: 'A^V', x: 505, y: 307, kind: 'found' },
    { label: 'A^H', x: 220, y: 320, kind: 'found' },
    { label: 'B^V', x: 571, y: 271, kind: 'found', note: '17px de jeu manuel sur le rappel' },
    { label: 'B^H', x: 123, y: 288, kind: 'found', note: '17px de jeu manuel sur le rappel' },
    { label: 'C^V', x: 578, y: 150, kind: 'found' },
    { label: 'C^H', x: 85, y: 160, kind: 'found' },
    { label: 'D^V', x: 503, y: 51, kind: 'found' },
    { label: 'D^H', x: 155, y: 63, kind: 'found' },
    { label: 'F^V', x: 426, y: 92, kind: 'found' },
    { label: 'F^H', x: 268, y: 104, kind: 'found' },
    { label: 'E^V', x: 426, y: 237, kind: 'found' },
    { label: 'E^H', x: 310, y: 237, kind: 'found' },
  ],

  // ── E 88 (fig37) — faisceau + rabattement, stays 2D. Outer frame 720×1260 (rotate(180) applied).
  //    Only one corner of the lone closed quad recall-pairs; the other three have no partner column. ──
  '29:p29-b0': [
    { label: 'A^H', x: 370, y: 822, kind: 'found' },
    { label: 'A^V', x: 377, y: 210, kind: 'found' },
    { label: 'coin ②', x: 216, y: 698, kind: 'unpaired', note: 'coin du quad — aucun partenaire H dans la colonne (Δx≫12)' },
    { label: 'coin ③', x: 330, y: 508, kind: 'unpaired', note: 'coin du quad — aucun partenaire V dans la colonne (Δx≫12)' },
    { label: 'coin ④', x: 497, y: 632, kind: 'unpaired', note: 'coin du quad — aucun partenaire V dans la colonne (Δx≫12)' },
  ],
  // ── E 91 (fig47) — pyramide S sur base A-M-B, stays 2D. Frame 720×1130. B^H jamais tracée. ──
  '34:p34-b18': [
    { label: 'S^V', x: 478, y: 120, kind: 'found' },
    { label: 'S^H', x: 485, y: 637, kind: 'found' },
    { label: 'A^V', x: 211, y: 392, kind: 'found' },
    { label: 'A^H', x: 205, y: 458, kind: 'found' },
    { label: 'M^V', x: 306, y: 391, kind: 'found' },
    { label: 'M^H', x: 310, y: 693, kind: 'found' },
    { label: 'B^V', x: 381, y: 395, kind: 'found' },
    { label: 'B^H', x: 381, y: 640, kind: 'missing', note: 'projection horizontale non tracée — 3e sommet de base introuvable' },
  ],
  // ── E 92 (fig48) — faisceau-des-traces, stays 2D. Outer frame 490×720 (rotate(-90) applied).
  //    Only O recall-pairs; A/B/C sit on the trace pencil and don't concord. ──
  '35:p35-b16': [
    { label: 'O^V', x: 143, y: 223, kind: 'found' },
    { label: 'O^H', x: 147, y: 415, kind: 'found' },
    { label: 'A^V', x: 333, y: 91, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ27)' },
    { label: 'A^H', x: 360, y: 585, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ27)' },
    { label: 'B^V', x: 329, y: 225, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ19)' },
    { label: 'B^H', x: 310, y: 191, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ19)' },
    { label: 'C^V', x: 308, y: 476, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ18)' },
    { label: 'C^H', x: 290, y: 414, kind: 'unpaired', note: 'sur une trace du faisceau, non concordant (Δ18)' },
  ],
  // ── E 85 (fig34) — pentagone O-A-B-K-L, stays 2D. Frame 720×510 (no transform). LT verticale,
  //    rappels horizontaux : O,A concordent ; B,L décalés ; K^V jamais tracée. ──
  '27:p27-b1': [
    { label: 'O^V', x: 491, y: 172, kind: 'found' },
    { label: 'O^H', x: 194, y: 172, kind: 'found' },
    { label: 'A^V', x: 494, y: 354, kind: 'found' },
    { label: 'A^H', x: 248, y: 354, kind: 'found' },
    { label: 'B^V', x: 386, y: 229, kind: 'unpaired', note: 'V/H décalés de 39px en y (190 vs 229)' },
    { label: 'B^H', x: 510, y: 190, kind: 'unpaired', note: 'V/H décalés de 39px en y (190 vs 229)' },
    { label: 'L^V', x: 494, y: 369, kind: 'unpaired', note: 'V/H décalés de 127px en y (242 vs 369)' },
    { label: 'L^H', x: 282, y: 242, kind: 'unpaired', note: 'V/H décalés de 127px en y (242 vs 369)' },
    { label: 'K^H', x: 362, y: 208, kind: 'found', note: 'projection horizontale tracée' },
    { label: 'K^V', x: 493, y: 208, kind: 'missing', note: 'projection V non tracée (seul K^V′ rabattu existe)' },
  ],
};

export function plateDiagnosticsFor(pageIndex: number, blockId: string): PlateDiagPoint[] | undefined {
  return PLATE_DIAGNOSTICS[`${pageIndex}:${blockId}`];
}
