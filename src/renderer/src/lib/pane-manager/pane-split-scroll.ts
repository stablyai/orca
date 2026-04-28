import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { restoreScrollState } from './pane-scroll'

// Why: wrapInSplit reparents the existing pane's container, which briefly
// detaches the WebGL canvas from the DOM. The WebGL renderer's internal
// render state can become stale after the re-attachment, leaving the canvas
// blank even though the terminal buffer has data. This mirrors the explicit
// refresh in resumeRendering() (pane-manager.ts) and the onContextLoss
// handler (pane-lifecycle.ts) which address the same "frozen terminal"
// symptom for analogous WebGL state transitions.
function refreshAfterReparent(pane: ManagedPaneInternal): void {
  try {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore — pane may have been disposed */
  }
}

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
        refreshAfterReparent(live)
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
    refreshAfterReparent(live)
  }, 200)
}
