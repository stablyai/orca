import { useLayoutEffect, useState, type RefObject } from 'react'

export const WORKER_DOCK_ROW = 30
const MAX_ROWS = 6
// Jump to latest (32px) and its 8px gap ride above the open card, so the card leaves them room.
const JUMP_ROOM = 40
const CRAMPED = 'data-worker-dock-cramped'

/** The card list's max height: six rows, or fewer when the chat above the pill is shorter, so the
 *  card and the Jump to latest above it never run off the pane. Re-read when the pane, the dock
 *  under the pill (a growing message box lifts it) or the card (a footer that appears) resizes. */
export function useWorkerDockCardBudget({
  root,
  pill,
  card,
  open,
  rows
}: {
  root: RefObject<HTMLElement | null>
  pill: RefObject<HTMLElement | null>
  card: RefObject<HTMLElement | null>
  open: boolean
  rows: number
}): number {
  const [budget, setBudget] = useState(WORKER_DOCK_ROW * MAX_ROWS)
  useLayoutEffect(() => {
    const pane = root.current?.closest('[data-native-chat-root]')
    if (!open || !pane) {
      return
    }
    const measure = () => {
      const paneTop = pane.getBoundingClientRect().top
      const pillTop = pill.current?.getBoundingClientRect().top
      const footer = card.current?.querySelector<HTMLElement>('[data-worker-dock-footer]')
      if (pillTop === undefined) {
        return
      }
      // Above the card: its 8px gap and padding, then Jump to latest's room and 8px of air.
      const room = pillTop - paneTop - 8 - 10 - (footer?.offsetHeight ?? 0) - JUMP_ROOM - 8
      setBudget(Math.max(WORKER_DOCK_ROW, Math.min(WORKER_DOCK_ROW * MAX_ROWS, room)))
      // Too short for even one row and Jump to latest: Jump steps aside while the card is open
      // (hidden, so nothing half off the pane can be pressed) and returns when it folds.
      pane.toggleAttribute(CRAMPED, room < WORKER_DOCK_ROW)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return () => pane.removeAttribute(CRAMPED)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [pane, root.current?.closest('[data-native-chat-dock]'), card.current]) {
      if (element) {
        observer.observe(element)
      }
    }
    return () => {
      observer.disconnect()
      pane.removeAttribute(CRAMPED)
    }
  }, [root, pill, card, open, rows])
  return budget
}
