import type { VisionCorrection } from './vision';

export interface AppliedVisionCorrection extends VisionCorrection {
  applied: boolean;
}

/** Apply only high-confidence replacements that still map unambiguously onto editable text. */
export function applyVisionCorrections(
  current: string,
  original: string,
  corrections: VisionCorrection[],
): { markdown: string; corrections: AppliedVisionCorrection[] } {
  const mapped: Array<{ at: number; correction: VisionCorrection }> = [];
  const occupied: Array<[number, number]> = [];

  for (const correction of corrections) {
    if (correction.confidence !== 'high' || original.slice(correction.start, correction.end) !== correction.ocr) continue;
    let at = current.slice(correction.start, correction.end) === correction.ocr ? correction.start : -1;
    if (at < 0) {
      const first = current.indexOf(correction.ocr);
      const second = first < 0 ? -1 : current.indexOf(correction.ocr, first + correction.ocr.length);
      if (first >= 0 && second < 0) at = first;
    }
    if (at < 0 || occupied.some(([a, b]) => at < b && at + correction.ocr.length > a)) continue;
    occupied.push([at, at + correction.ocr.length]);
    mapped.push({ at, correction });
  }

  let markdown = current;
  for (const { at, correction } of [...mapped].sort((a, b) => b.at - a.at)) {
    markdown = markdown.slice(0, at) + correction.replacement + markdown.slice(at + correction.ocr.length);
  }
  const applied = new Set(mapped.map((m) => m.correction));
  return { markdown, corrections: corrections.map((c) => ({ ...c, applied: applied.has(c) })) };
}
