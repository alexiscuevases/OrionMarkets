import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** Marca: el cinturón de Orión. */
export const OrionMark = ({ size = 22, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" {...p}>
    <rect width="32" height="32" rx="8" fill="var(--bg-raised)" stroke="var(--line-strong)" />
    <line x1="9" y1="23" x2="23" y2="9" stroke="var(--line-strong)" strokeWidth="1.2" />
    <circle cx="9" cy="23" r="2.1" fill="var(--star)" />
    <circle cx="16" cy="16" r="2.8" fill="var(--star)" />
    <circle cx="23" cy="9" r="2.1" fill="var(--star)" />
  </svg>
);

export const SearchIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m13.5 13.5-3.2-3.2" />
  </svg>
);

export const CandlesIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 2v2M4.5 12v2M11.5 2.5v1.5M11.5 11v2.5" />
    <rect x="2.8" y="4" width="3.4" height="8" rx="0.8" />
    <rect x="9.8" y="4" width="3.4" height="7" rx="0.8" fill="currentColor" stroke="none" />
  </svg>
);

export const OhlcIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 2.5v11M2.5 5h2M4.5 11h2" />
    <path d="M11.5 2.5v11M9.5 4.5h2M11.5 10.5h2" />
  </svg>
);

export const LineIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2 12.5 6 7l3 2.5 5-6.5" />
  </svg>
);

export const AreaIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2 12.5 6 7l3 2.5 5-6.5" />
    <path d="M2 12.5 6 9.5l3 1.5 5-4v6.5H2z" fill="currentColor" stroke="none" opacity="0.35" />
  </svg>
);

export const LayersIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m8 2 6 3-6 3-6-3 6-3Z" />
    <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
  </svg>
);

export const SparkleIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.5 9.6 6 14 7.5 9.6 9 8 13.5 6.4 9 2 7.5 6.4 6 8 1.5Z" />
    <circle cx="13" cy="13" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const GearIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
  </svg>
);

export const BellIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3.5 11.5h9c-1-1-1.5-2-1.5-4a3 3 0 0 0-6 0c0 2-.5 3-1.5 4Z" />
    <path d="M6.8 13.5a1.3 1.3 0 0 0 2.4 0" />
  </svg>
);

/** Capa Smart Money: bloques de órdenes apilados. */
export const BlocksIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="2" y="3" width="8.5" height="3.6" rx="1" />
    <rect x="5.5" y="9.4" width="8.5" height="3.6" rx="1" />
    <path d="M12.5 4.8H14M2 11.2h1.5" />
  </svg>
);

export const TargetIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.5" />
    <circle cx="8" cy="8" r="0.5" fill="currentColor" stroke="none" />
  </svg>
);

export const ArrowUp = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </svg>
);

export const ArrowDown = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </svg>
);

export const ChevronDown = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m4 6 4 4 4-4" />
  </svg>
);
