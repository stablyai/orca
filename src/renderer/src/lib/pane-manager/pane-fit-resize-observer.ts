import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'

export function attachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  detachPaneFitResizeObserver(pane)

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  const observer = new ResizeObserver(() => {
    if (pane.pendingObservedFitRafId !== null) {
      return
    }
    // Why: keep xterm fit work off the divider pointermove hot path and let
    // the browser coalesce drag-driven size changes the same way Superset does.
    pane.pendingObservedFitRafId = requestAnimationFrame(() => {
      pane.pendingObservedFitRafId = null
      safeFit(pane)
    })
  })

  observer.observe(pane.xtermContainer)
  pane.fitResizeObserver = observer
}

export function detachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  pane.fitResizeObserver?.disconnect()
  pane.fitResizeObserver = null

  if (pane.pendingObservedFitRafId !== null) {
    cancelAnimationFrame(pane.pendingObservedFitRafId)
    pane.pendingObservedFitRafId = null
  }
}
