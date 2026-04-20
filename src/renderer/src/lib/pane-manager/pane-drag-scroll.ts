import type { ManagedPaneInternal } from './pane-manager-types'
import { captureScrollState, restoreScrollState } from './pane-scroll'

// ---------------------------------------------------------------------------
// Drag-scroll locking: capture scroll state once at drag start, reuse for
// every restore during the drag to prevent cumulative drift.
// ---------------------------------------------------------------------------

export function lockDragScroll(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of findManagedPanesUnder(el, panes)) {
    if (!pane.pendingDragScrollState) {
      pane.pendingDragScrollState = captureScrollState(pane.terminal)
    }
  }
}

export function unlockDragScroll(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of findManagedPanesUnder(el, panes)) {
    if (pane.pendingDragScrollState) {
      try {
        restoreScrollState(pane.terminal, pane.pendingDragScrollState)
      } catch {
        /* ignore */
      }
      pane.pendingDragScrollState = null
    }
  }
}

function findManagedPanesUnder(
  el: HTMLElement,
  panes: Map<number, ManagedPaneInternal>
): ManagedPaneInternal[] {
  const result: ManagedPaneInternal[] = []
  if (el.classList.contains('pane')) {
    const pane = panes.get(Number(el.dataset.paneId))
    if (pane) {
      result.push(pane)
    }
  } else if (el.classList.contains('pane-split')) {
    for (const paneEl of el.querySelectorAll('.pane[data-pane-id]')) {
      const pane = panes.get(Number((paneEl as HTMLElement).dataset.paneId))
      if (pane) {
        result.push(pane)
      }
    }
  }
  return result
}
