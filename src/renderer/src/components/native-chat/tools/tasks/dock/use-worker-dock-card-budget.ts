import { useLayoutEffect, useState, type RefObject } from 'react'

// A row's resting height: a one-line title over its model and age.
export const WORKER_DOCK_ROW = 44
const MAX_ROWS = 6
// Jump to latest (26px) and its 8px gap rest above the open panel, so the panel leaves them room.
const JUMP_ROOM = 34
const CRAMPED = 'data-worker-dock-cramped'

/** The panel list's max height: six rows, or fewer when the chat above the dock is shorter, so the
 *  panel and the Jump to latest above it never run off the pane. Re-read when the pane, the dock
 *  under the panel (a growing message box lifts it) or the panel (a footer that appears) resizes. */
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
      const bottom = card.current?.getBoundingClientRect().bottom
      const header = pill.current?.offsetHeight ?? 0
      const footer = card.current?.querySelector<HTMLElement>('[data-worker-dock-footer]')
      if (bottom === undefined) {
        return
      }
      // Besides the list: the panel's header, padding, gaps and border, then Jump to latest's room and 8px of air.
      const room = bottom - paneTop - header - 14 - (footer?.offsetHeight ?? 0) - JUMP_ROOM - 8
      setBudget(Math.max(WORKER_DOCK_ROW, Math.min(WORKER_DOCK_ROW * MAX_ROWS, room)))
      // Too short for one row and Jump to latest even without the air: Jump steps aside while the card is open
      // (hidden, so nothing half off the pane can be pressed) and returns when it folds.
      pane.toggleAttribute(CRAMPED, room + 8 < WORKER_DOCK_ROW)
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
