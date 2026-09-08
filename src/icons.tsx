// One authored 24px stroke set. Stroke width and caps come from the theme (--stroke, CSS).
const c = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
const r = (x: number, y: number, w: number, h: number, k = 2) =>
  `M${x + k} ${y}h${w - 2 * k}a${k} ${k} 0 0 1 ${k} ${k}v${h - 2 * k}a${k} ${k} 0 0 1 ${-k} ${k}h${-(w - 2 * k)}a${k} ${k} 0 0 1 ${-k} ${-k}v${-(h - 2 * k)}a${k} ${k} 0 0 1 ${k} ${-k}z`

const P = {
  back: 'M15 18l-6-6 6-6',
  settings: `M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1${c(15, 6, 2)}${c(9, 12, 2)}${c(17, 18, 2)}`,
  user: `${c(12, 8, 4)}M4 21c0-4 3.6-6 8-6s8 2 8 6`,
  plus: 'M12 5v14M5 12h14',
  send: 'M21 3L10 14M21 3l-6.5 18-4.5-7-7-4.5z',
  qr: `${r(3, 3, 7, 7, 1)}${r(14, 3, 7, 7, 1)}${r(3, 14, 7, 7, 1)}M14 14h3v3h-3zM20 14v.01M14 21h3M20 17v4`,
  check: 'M5 12.5l4.5 4.5L19 7.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9M10 20.5a2.2 2.2 0 0 0 4 0',
  cash: `${r(2, 6, 20, 12)}${c(12, 12, 2.5)}M6 9.5v.01M18 14.5v.01`,
  copy: `${r(9, 9, 12, 12)}M5 15V5a2 2 0 0 1 2-2h10`,
  // categories
  food: 'M3 11h18a9 9 0 0 1-18 0zM8 7.5c0-1.5 1.2-2 1.2-3.5M12 7.5c0-1.5 1.2-2 1.2-3.5M16 7.5c0-1.5 1.2-2 1.2-3.5',
  groceries: 'M5.5 7.5h13l1 13.5h-15zM9 7.5a3 3 0 0 1 6 0',
  stay: `M3 19V6M3 14h18v5M21 14a3 3 0 0 0-3-3h-7v3${c(7, 11.5, 1.6)}`,
  transport: 'M5 16v-4.5L7 6h10l2 5.5V16zM3 16h18M7 19v-3M17 19v-3M8 12.5h.01M16 12.5h.01',
  drinks: 'M7 3h10l-1 9a4 4 0 0 1-8 0zM12 16v5M8.5 21h7M7.5 7h9',
  fun: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2zM14 6v2.5M14 11v2M14 15.5V18',
  rent: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  bills: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12z',
  help: 'M19 3l-7 7M9.5 10.5l4 4M4 20.5c3 0 6-1.2 8-4.5l-4-4c-3.2 2-4 5-4 8.5z',
  other: 'M6 2.5h12v19l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3.5',
  // group kinds
  trip: 'M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0v5l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z',
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  couple: 'M12 20s-7.5-4.6-7.5-10.2A4 4 0 0 1 12 7.3a4 4 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z',
  friends: `${c(9, 8, 3.5)}M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M19 14.7c1.8.8 3 2.4 3 5.3`,
  office: `${r(3, 7, 18, 13)}M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7M3 13h18`,
  family: `${c(7.5, 7, 2.8)}${c(16.5, 7, 2.8)}${c(12, 14, 2)}M2 20c0-3 2.4-5 5.5-5M22 20c0-3-2.4-5-5.5-5M8.8 21c0-2 1.4-3.3 3.2-3.3s3.2 1.3 3.2 3.3`,
} as const

export type IconName = keyof typeof P

export function Icon({ n, size = 22, label }: { n: IconName; size?: number; label?: string }) {
  return (
    <svg className="icon-svg" width={size} height={size} viewBox="0 0 24 24" role={label ? 'img' : undefined}
      aria-label={label} aria-hidden={label ? undefined : true} fill="none" stroke="currentColor">
      <path d={P[n]} />
    </svg>
  )
}

export const CATS: { id: IconName; label: string }[] = [
  { id: 'food', label: 'Food' }, { id: 'groceries', label: 'Groceries' }, { id: 'stay', label: 'Stay' },
  { id: 'transport', label: 'Transport' }, { id: 'drinks', label: 'Drinks' }, { id: 'fun', label: 'Fun' },
  { id: 'rent', label: 'Rent' }, { id: 'bills', label: 'Bills' }, { id: 'help', label: 'House help' }, { id: 'other', label: 'Other' },
]
