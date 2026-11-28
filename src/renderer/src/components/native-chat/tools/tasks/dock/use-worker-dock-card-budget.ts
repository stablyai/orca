import { useLayoutEffect, useState, type RefObject } from 'react'
import { workerDockHeightObserver, workerDockScope } from './WorkerDockPill'
import { workerChipAnchor } from './worker-chip-slot'

// A row's resting height: one line of title and age.
export const WORKER_DOCK_ROW = 32
const MAX_ROWS = 6
// Jump to latest (32px) and its 8px gap ride above the open panel, so the panel leaves them room.
const JUMP_ROOM = 40
const CRAMPED = 'data-worker-dock-cramped'

/** The panel list's max height: six rows, or fewer when the chat above the dock is shorter, so the
 *  panel and the Jump to latest above it never run off the pane. Re-read when the pane, the dock or the
 *  task list under the panel (either lifts it as it grows) resizes; the panel's own growth (every frame
 *  of the morph) moves nothing this reads. */
export function useWorkerDockCardBudget({
  root,
  card,
  open,
  dropped,
  rows,
  placement
}: {
  root: RefObject<HTMLElement | null>
  card: RefObject<HTMLElement | null>
  open: boolean
  /** Whether the card may drop over the dock when short of room: open, not folding back. */
  dropped: boolean
  rows: number
  /** The slot the chip draws in: moved to another, it measures again there. */
  placement: HTMLElement | null
}): number {
  const [budget, setBudget] = useState(WORKER_DOCK_ROW * MAX_ROWS)
  useLayoutEffect(() => {
    const row = root.current
    const element = card.current
    const pane = row?.closest('[data-native-chat-root]')
    // Jump to latest's cramped state belongs to the main transcript only, not a subagent sheet.
    const scope = workerDockScope(row)
    const header = element?.firstElementChild
    if (!open || !row || !element || !pane || !scope) {
      return
    }
    const measure = () => {
      const paneTop = pane.getBoundingClientRect().top
      // The chip's row, not the card: the card may be dropped below it (see `drop`).
      const bottom = row.getBoundingClientRect().top
      // Besides the list: the header (bulk actions included), the list's 4px padding above and
      // below, and the borders, then Jump to latest's room and 8px of air.
      const headerHeight = header instanceof HTMLElement ? header.offsetHeight : 0
      const room = bottom - paneTop - headerHeight - 10 - JUMP_ROOM - 8
      const next = Math.max(WORKER_DOCK_ROW, Math.min(WORKER_DOCK_ROW * MAX_ROWS, room))
      setBudget(next)
      // Too short for one row and Jump to latest even without the air: Jump steps aside while the card is open
      // (hidden, so nothing half off the pane can be pressed) and returns when it folds.
      scope.toggleAttribute(CRAMPED, room + 8 < WORKER_DOCK_ROW)
      // Shorter still (the dock has taken the transcript's floor): the card drops over the dock
      // rather than rising past the pane's top, 4px below it.
      const drop = Math.max(0, headerHeight + 10 + next - (bottom - paneTop - 4))
      if (drop && dropped) {
        element.style.setProperty('translate', `0 ${drop}px`)
      } else {
        element.style.removeProperty('translate')
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        scope.removeAttribute(CRAMPED)
        element.style.removeProperty('translate')
      }
    }
    // The card rides the transcript's end, which rises as anything under it grows (the message box,
    // a docked task list that mounts or opens): the transcript viewport just before the chip's row
    // shrinks for all of them. The header settles taller once a long Stop label wraps. Only height
    // matters: the header widens on every frame of the morph.
    const observer = workerDockHeightObserver(measure)
    const viewport = workerChipAnchor(row)?.previousElementSibling
    for (const target of [pane, viewport, header]) {
      if (target) {
        observer.observe(target)
      }
    }
    return () => {
      observer.disconnect()
      scope.removeAttribute(CRAMPED)
      element.style.removeProperty('translate')
    }
  }, [root, card, open, dropped, rows, placement])
  return budget
}
