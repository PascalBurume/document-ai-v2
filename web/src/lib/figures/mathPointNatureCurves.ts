/**
 * Four small curves printed inside the middle column of the point-nature table on scan page 319.
 * OCR retained the surrounding table text but emitted no image regions for these drawings. These
 * are source-matched teaching reconstructions, deliberately simple and labelled like the scan.
 */
const frame = (content: string, label: string) => `<svg viewBox="0 0 220 130" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 108H202M22 108V18"/><path d="M202 108l-8-4v8zM22 18l-4 8h8z" fill="#111827"/>
    ${content}
  </g>
  <g fill="#111827" font-family="Arial, sans-serif" font-size="11"><text x="205" y="112">x</text><text x="15" y="15">y</text><text x="15" y="123">O</text></g>
</svg>`;

export const MATH_POINT_NATURE_CURVES = [
  frame(
    '<path d="M40 62C65 60 82 70 100 91C119 66 145 60 174 67"/>' +
    '<path d="M100 91L72 24M100 91L137 22"/>' +
    '<path d="M100 105V111"/><circle cx="100" cy="91" r="3" fill="#111827"/>' +
    '<g fill="#111827" stroke="none" font-family="Arial, sans-serif" font-size="11"><text x="104" y="88">A</text><text x="94" y="124">x₀</text><text x="65" y="22">t₁</text><text x="139" y="21">t₂</text><text x="176" y="66">(c)</text></g>',
    'Point anguleux : deux demi-tangentes obliques',
  ),
  frame(
    '<path d="M43 48C70 45 94 48 100 68C106 89 138 91 177 101"/>' +
    '<path d="M100 24V108"/><circle cx="100" cy="68" r="3" fill="#111827"/>' +
    '<g fill="#111827" stroke="none" font-family="Arial, sans-serif" font-size="11"><text x="84" y="66">A</text><text x="105" y="25">t</text><text x="94" y="124">x₀</text><text x="178" y="101">(c)</text></g>',
    'Point d’inflexion avec tangente verticale traversante',
  ),
  frame(
    '<path d="M100 72C112 44 145 34 181 27M100 72C114 94 146 101 181 109"/>' +
    '<path d="M100 24V108"/><circle cx="100" cy="72" r="3" fill="#111827"/>' +
    '<g fill="#111827" stroke="none" font-family="Arial, sans-serif" font-size="11"><text x="84" y="72">A</text><text x="105" y="25">t</text><text x="94" y="124">x₀</text><text x="181" y="28">(c)</text></g>',
    'Point de rebroussement avec tangente verticale',
  ),
  frame(
    '<path d="M100 92C108 57 143 36 184 28"/>' +
    '<path d="M100 28V108"/><circle cx="100" cy="92" r="3" fill="#111827"/>' +
    '<g fill="#111827" stroke="none" font-family="Arial, sans-serif" font-size="11"><text x="84" y="92">A</text><text x="105" y="29">t</text><text x="94" y="124">x₀</text><text x="184" y="28">(c)</text></g>',
    'Point d’arrêt avec tangente verticale',
  ),
] as const;
