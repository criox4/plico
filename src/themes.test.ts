import assert from 'node:assert/strict'
import { THEMES, contrast } from './themes.ts'

// Every theme must keep money legible: WCAG AA on every text pair it ships.
const fails: string[] = []
for (const t of THEMES) {
  const c = t.c
  const pairs: [string, string, string, number][] = [
    ['ink/bg', c.ink, c.bg, 4.5], ['ink/surface', c.ink, c.surface, 4.5], ['ink/surface2', c.ink, c.surface2, 4.5],
    ['muted/bg', c.muted, c.bg, 4.5], ['muted/surface', c.muted, c.surface, 4.5],
    ['link/bg', c.link, c.bg, 4.5], ['link/surface', c.link, c.surface, 4.5],
    ['pos/bg', c.pos, c.bg, 4.5], ['pos/surface', c.pos, c.surface, 4.5],
    ['neg/bg', c.neg, c.bg, 4.5], ['neg/surface', c.neg, c.surface, 4.5],
    ['onAccent/accent', c.onAccent, c.accent, 4.5], ['settled/surface', c.settled, c.surface, 3],
    ['accent/bg (FAB edge)', c.accent, c.bg, 3],
  ]
  for (const [n, a, b, min] of pairs) {
    const r = contrast(a, b)
    if (r < min) fails.push(`${t.id} ${n} ${r.toFixed(2)} < ${min}`)
  }
}
assert.equal(new Set(THEMES.map(t => t.id)).size, 16)
assert.deepEqual(fails, [])
console.log('themes ok')
