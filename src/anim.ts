// Shared motion recipes (Motion for React). A money app: firm springs, no overshoot.
// Lists wrap their rows in <AnimatePresence initial={false}> so nothing plays when a screen first appears.
export const SPRING = { type: 'spring', bounce: 0, visualDuration: 0.3 } as const

/** A row in a list: arrives with a small drop and fade, leaves with a quick fade, and its neighbours slide into place.
 *  ponytail: `layout` measures every row on each re-render; fine for groups of hundreds of expenses, window the list past that. */
export const ROW = {
  layout: 'position',
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
  transition: SPRING,
} as const

/** A block that comes and goes as a whole (a list's last row leaving, its empty state arriving). */
export const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.18 } } as const

/** Where Plico looks, for a point dx, dy px from its centre: the face's offset in drawing units (at most 1.6) and the
 *  bowl's lean in degrees (at most 4). Inside `dead` px it looks straight ahead; the pull eases in over the next 160px. */
export function gaze(dx: number, dy: number, dead: number): [number, number, number] {
  const d = Math.hypot(dx, dy)
  if (d <= dead) return [0, 0, 0]
  const k = (Math.min(1, (d - dead) / 160) * 1.6) / d
  const r = (n: number) => Math.round(n * 100) / 100 || 0
  return [r(dx * k), r(dy * k), r(dx * k * 2.5)]
}
