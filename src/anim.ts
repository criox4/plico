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
