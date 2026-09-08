// Theme engine. A theme re-inks the Mint Proof grammar: colour, type, shape, stroke,
// ornament, motion and the settle celebration. Money semantics never change:
// pos = owed to you, neg = you owe, settled = only for settled. All pairs pass WCAG AA (npm test).

export const BRAND = { indigo: '#6C5CE7', dark: '#5145CD', light: '#EAE7FF' }

export type ThemeId =
  | 'classic' | 'midnight' | 'khata' | 'goa' | 'mono' | 'retro'
  | 'monsoon' | 'cyber' | 'pixel' | 'matcha' | 'chai' | 'auto'

type Colors = {
  bg: string; surface: string; surface2: string; ink: string; muted: string; line: string
  accent: string; onAccent: string; link: string; pos: string; neg: string; settled: string
}
export type ThemeDef = {
  id: ThemeId
  name: string
  line: string // one-line personality
  dark: boolean
  c: Colors
  ui: string // UI face
  num: string // numerals / display face
  fonts: string[] // Google Fonts css2 family specs
  radius: number
  stroke: number
  ornament: 'guilloche' | 'ripple' | 'ledger' | 'meter' | 'none'
  celebrate: string // the word the settle seal prints
  motion: 'calm' | 'fluid' | 'snappy' | 'steps' | 'bouncy'
}

const f = {
  anek: 'Anek+Latin:wdth,wght@75..125,300..800',
  bodoni: 'Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900',
  martelSans: 'Martel+Sans:wght@400;600;800',
  kalam: 'Kalam:wght@400;700',
  baloo: 'Baloo+2:wght@400..800',
  archivo: 'Archivo:wdth,wght@62..125,100..900',
  eczar: 'Eczar:wght@400..800',
  mukta: 'Mukta:wght@200;400;600;800',
  khand: 'Khand:wght@500;700',
  pixelify: 'Pixelify+Sans:wght@400..700',
  silkscreen: 'Silkscreen:wght@400;700',
  hind: 'Hind:wght@400;500;600',
  youngSerif: 'Young+Serif',
  yatra: 'Yatra+One',
  rajdhani: 'Rajdhani:wght@500;600;700',
  teko: 'Teko:wght@400..700',
}

export const THEMES: ThemeDef[] = [
  {
    id: 'classic', name: 'Classic', line: 'Splittr Indigo, engraved numerals, hairline guilloche. The brand at rest.',
    dark: false, radius: 16, stroke: 1.6, ornament: 'guilloche', celebrate: 'Settled', motion: 'calm',
    ui: "'Anek Latin'", num: "'Bodoni Moda'", fonts: [f.anek, f.bodoni],
    c: { bg: '#F7F7FB', surface: '#FFFFFF', surface2: '#EFEEF6', ink: '#17171C', muted: '#5E5E6A', line: '#E3E2EC',
      accent: '#6C5CE7', onAccent: '#FFFFFF', link: '#5145CD', pos: '#0B7A56', neg: '#C8374A', settled: '#8F6410' },
  },
  {
    id: 'midnight', name: 'Midnight', line: 'Violet light on charcoal glass. Dark-first, dramatic, quiet.',
    dark: true, radius: 18, stroke: 1.5, ornament: 'guilloche', celebrate: 'Settled', motion: 'fluid',
    ui: "'Anek Latin'", num: "'Bodoni Moda'", fonts: [f.anek, f.bodoni],
    c: { bg: '#0D0D12', surface: '#17171F', surface2: '#21212C', ink: '#F1F0F7', muted: '#A3A2B5', line: '#2B2B39',
      accent: '#9D7BF8', onAccent: '#0D0D12', link: '#B49BFA', pos: '#3DD39B', neg: '#FF7D89', settled: '#E6BC62' },
  },
  {
    id: 'khata', name: 'Khata', line: 'A red-bound bahi-khata: ruled paper, maroon margin, amounts in ink.',
    dark: false, radius: 4, stroke: 1.8, ornament: 'ledger', celebrate: 'Hisaab clear', motion: 'calm',
    ui: "'Martel Sans'", num: "'Kalam'", fonts: [f.martelSans, f.kalam],
    c: { bg: '#F7E9CF', surface: '#FCF4E3', surface2: '#F1DFBD', ink: '#302B28', muted: '#65574A', line: '#E2CBA2',
      accent: '#8A3F4A', onAccent: '#FCF4E3', link: '#7A3140', pos: '#2A6A37', neg: '#B3261E', settled: '#80590F' },
  },
  {
    id: 'goa', name: 'Goa', line: 'Sand, turquoise water, coral sunset. Stickers on a trip notebook.',
    dark: false, radius: 24, stroke: 2.2, ornament: 'guilloche', celebrate: 'Sorted!', motion: 'bouncy',
    ui: "'Baloo 2'", num: "'Baloo 2'", fonts: [f.baloo],
    c: { bg: '#FFF2D8', surface: '#FFFAEE', surface2: '#FFE6BD', ink: '#2A1F14', muted: '#6A5641', line: '#F0D9AE',
      accent: '#0A7A70', onAccent: '#FFFFFF', link: '#0A6F66', pos: '#107A45', neg: '#C1304A', settled: '#8C5E0E' },
  },
  {
    id: 'mono', name: 'Mono', line: 'Graphite and white only. Type does all the work.',
    dark: false, radius: 0, stroke: 1.5, ornament: 'guilloche', celebrate: 'SETTLED', motion: 'snappy',
    ui: "'Archivo'", num: "'Archivo'", fonts: [f.archivo],
    c: { bg: '#FFFFFF', surface: '#FFFFFF', surface2: '#F1F1F1', ink: '#111111', muted: '#545454', line: '#111111',
      accent: '#25252A', onAccent: '#FFFFFF', link: '#111111', pos: '#0E7443', neg: '#B0202D', settled: '#111111' },
  },
  {
    id: 'retro', name: 'Retro India', line: 'Buff railway card tickets, railway blue, violet PAID stamps.',
    dark: false, radius: 3, stroke: 1.6, ornament: 'guilloche', celebrate: 'PAID', motion: 'snappy',
    ui: "'Eczar'", num: "'Eczar'", fonts: [f.eczar],
    c: { bg: '#EAD8B6', surface: '#F5EACF', surface2: '#E4CFA6', ink: '#2B1B14', muted: '#5C4533', line: '#CDB185',
      accent: '#1F3F7A', onAccent: '#F5EACF', link: '#1F3F7A', pos: '#2C6630', neg: '#A1281E', settled: '#5B3A8C' },
  },
  {
    id: 'monsoon', name: 'Monsoon', line: 'Wet slate and sea-glass. Ripples, long fluid motion.',
    dark: true, radius: 20, stroke: 1.4, ornament: 'ripple', celebrate: 'All clear', motion: 'fluid',
    ui: "'Mukta'", num: "'Mukta'", fonts: [f.mukta],
    c: { bg: '#0F2A33', surface: '#14363F', surface2: '#1B4450', ink: '#E7F3F3', muted: '#A2C3C7', line: '#265564',
      accent: '#7FD6C8', onAccent: '#0F2A33', link: '#8FE0D3', pos: '#74E8AE', neg: '#FF9A9A', settled: '#F2D27A' },
  },
  {
    id: 'cyber', name: 'Cyber', line: 'Acid lime on near-black. Loud, condensed, experimental.',
    dark: true, radius: 6, stroke: 1.8, ornament: 'guilloche', celebrate: 'SETTLED', motion: 'snappy',
    ui: "'Anek Latin'", num: "'Khand'", fonts: [f.anek, f.khand],
    c: { bg: '#11120F', surface: '#1A1C17', surface2: '#252820', ink: '#F2F5EA', muted: '#A7AE9A', line: '#343929',
      accent: '#B8F34A', onAccent: '#11120F', link: '#B8F34A', pos: '#4BE3A0', neg: '#FF6B80', settled: '#F5D64C' },
  },
  {
    id: 'pixel', name: 'Pixel', line: 'A sixteen-colour palette with strict laws. Dialog boxes, coins, 1-UPs.',
    dark: true, radius: 0, stroke: 2, ornament: 'none', celebrate: '+1UP SETTLED', motion: 'steps',
    ui: "'Pixelify Sans'", num: "'Silkscreen'", fonts: [f.pixelify, f.silkscreen],
    c: { bg: '#1D2B53', surface: '#000000', surface2: '#1D2B53', ink: '#FFF1E8', muted: '#C2C3C7', line: '#FFF1E8',
      accent: '#FFEC27', onAccent: '#000000', link: '#FFEC27', pos: '#00E436', neg: '#FF77A8', settled: '#FFA300' },
  },
  {
    id: 'matcha', name: 'Matcha', line: 'Sage and warm cream. Calm enough for the monthly rent.',
    dark: false, radius: 20, stroke: 1.6, ornament: 'ripple', celebrate: 'Settled', motion: 'calm',
    ui: "'Hind'", num: "'Young Serif'", fonts: [f.hind, f.youngSerif],
    c: { bg: '#F4F1E8', surface: '#FBFAF5', surface2: '#E8EEE2', ink: '#1F2A1F', muted: '#566151', line: '#DCE2D1',
      accent: '#4A7A4F', onAccent: '#FFFFFF', link: '#3F6B44', pos: '#1B7248', neg: '#B42F3C', settled: '#85630F' },
  },
  {
    id: 'chai', name: 'Chai', line: 'A tapri: blue tarp, steel tumblers, chai amber, hand-painted board.',
    dark: false, radius: 12, stroke: 1.8, ornament: 'ripple', celebrate: 'Cutting clear', motion: 'fluid',
    ui: "'Mukta'", num: "'Yatra One'", fonts: [f.mukta, f.yatra],
    c: { bg: '#E9EDEF', surface: '#F7F8F8', surface2: '#DDE3E6', ink: '#1C2226', muted: '#505C64', line: '#C8D0D5',
      accent: '#1F5FA8', onAccent: '#FFFFFF', link: '#1B5596', pos: '#12713F', neg: '#B92D3D', settled: '#8F5E0E' },
  },
  {
    id: 'auto', name: 'Auto', line: 'Canary canopy, CNG green, a fare meter that reads your balance.',
    dark: false, radius: 10, stroke: 2.4, ornament: 'guilloche', celebrate: 'Meter down', motion: 'snappy',
    ui: "'Rajdhani'", num: "'Teko'", fonts: [f.rajdhani, f.teko],
    c: { bg: '#FFD60A', surface: '#FFFBEA', surface2: '#FFEE99', ink: '#111111', muted: '#3F3A1E', line: '#111111',
      accent: '#0B6B3A', onAccent: '#FFFFFF', link: '#0B5E33', pos: '#0A6634', neg: '#B0141F', settled: '#111111' },
  },
]

export const theme = (id: ThemeId) => THEMES.find(t => t.id === id) ?? THEMES[0]

const EASE = {
  calm: ['cubic-bezier(.22,1,.36,1)', '320ms'],
  fluid: ['cubic-bezier(.16,1,.3,1)', '620ms'],
  snappy: ['cubic-bezier(.2,.9,.1,1)', '180ms'],
  steps: ['steps(4, end)', '280ms'],
  bouncy: ['cubic-bezier(.34,1.56,.64,1)', '420ms'],
} as const

/** CSS custom properties for a theme; put on any element with data-theme. */
export function themeVars(id: ThemeId): Record<string, string> {
  const t = theme(id)
  const v: Record<string, string> = {
    '--ui': `${t.ui}, system-ui, sans-serif`,
    '--num': `${t.num}, ${t.ui}, system-ui, serif`,
    '--radius': `${t.radius}px`,
    '--radius-sm': `${Math.min(t.radius, 12)}px`,
    '--stroke': String(t.stroke),
    '--ease': EASE[t.motion][0],
    '--dur': EASE[t.motion][1],
    '--brand': BRAND.indigo,
    'colorScheme': t.dark ? 'dark' : 'light',
  }
  for (const [k, val] of Object.entries(t.c)) v['--' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())] = val
  return v
}

/** Load a theme's faces once, on demand, so the app only downloads what it shows. */
export function ensureFonts(ids: ThemeId[]) {
  const specs = [...new Set(ids.flatMap(id => theme(id).fonts))].filter(s => !document.querySelector(`link[data-font="${s}"]`))
  for (const s of specs) {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.dataset.font = s
    l.href = `https://fonts.googleapis.com/css2?family=${s}&display=swap`
    document.head.append(l)
  }
}

// WCAG 2.x contrast
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
