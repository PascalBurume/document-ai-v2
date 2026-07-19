import type { ReactNode } from 'react';

/**
 * The app's entire icon set: 16×16, stroke-only, currentColor. Inline SVG instead of emoji
 * because emoji render differently on every platform and fight the flat aesthetic; stroke-only
 * so every icon inherits its button's text color, including disabled grey.
 */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconPlus = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const IconSliders = () => (
  <Icon>
    <path d="M3 5h10M3 11h10" />
    <circle cx="6" cy="5" r="1.7" fill="var(--bg, #fff)" />
    <circle cx="10" cy="11" r="1.7" fill="var(--bg, #fff)" />
  </Icon>
);

export const IconDownload = () => (
  <Icon>
    <path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10" />
  </Icon>
);

export const IconCode = () => (
  <Icon>
    <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
  </Icon>
);

/** Restart — the counter-clockwise "start over" arrow. */
export const IconRotate = () => (
  <Icon>
    <path d="M3.2 6.6a5 5 0 1 1-.5 3.2" />
    <path d="M3 3.5v3.3h3.3" />
  </Icon>
);

/** Force re-run — clockwise refresh, deliberately distinct from Restart. */
export const IconRefresh = () => (
  <Icon>
    <path d="M12.8 6.6a5 5 0 1 0 .5 3.2" />
    <path d="M13 3.5v3.3H9.7" />
  </Icon>
);

export const IconPlay = () => (
  <Icon>
    <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconEllipsis = () => (
  <Icon>
    <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconDoc = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 1.5h5L12.5 5v9.5h-8.5z" />
    <path d="M9 1.5V5h3.5" />
  </Icon>
);

export const IconTrash = () => (
  <Icon>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
  </Icon>
);

export const IconPen = () => (
  <Icon>
    <path d="m3 13 .8-3.2 7.4-7.4a1.2 1.2 0 0 1 1.7 0l.7.7a1.2 1.2 0 0 1 0 1.7L6.2 12.2z" />
  </Icon>
);

export const IconZap = () => (
  <Icon>
    <path d="M8.8 1.5 3.5 9h3.5l-.8 5.5L11.5 7H8z" fill="currentColor" stroke="none" />
  </Icon>
);
