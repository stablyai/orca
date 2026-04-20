import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { restoreScrollState } from './pane-scroll'

// Why: reparenting a terminal container during split resets the viewport
// scroll position (browser clears scrollTop on DOM move). This schedules a
// two-phase restore: an early double-rAF (~32ms) to minimise the visible
// flash, plus a 200ms authoritative restore that also clears the scroll lock.
export function scheduleSplitScrollRestore(
  getPaneById: (id: number) => ManagedPaneInternal | undefined,
  paneId: number,
  scrollState: ScrollState,
  isDestroyed: () => boolean
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (isDestroyed()) {
        return
      }
      const live = getPaneById(paneId)
      if (live?.pendingSplitScrollState) {
        restoreScrollState(live.terminal, scrollState)
      }
    })
  })

  setTimeout(() => {
    if (isDestroyed()) {
      return
    }
    const live = getPaneById(paneId)
    if (!live) {
      return
    }
    live.pendingSplitScrollState = null
    restoreScrollState(live.terminal, scrollState)
  }, 200)
}
