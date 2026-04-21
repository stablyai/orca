import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
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

export function captureAllPaneScrollStates(
  panes: Map<number, ManagedPaneInternal>
): Map<number, ScrollState> {
  const states = new Map<number, ScrollState>()
  for (const pane of panes.values()) {
    if (
      !pane.pendingSplitScrollState &&
      !pane.pendingDragScrollState &&
      !pane.pendingLayoutScrollState
    ) {
      states.set(pane.id, captureScrollState(pane.terminal))
    }
  }
  return states
}

export function lockAllPaneScrollStates(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    if (
      !pane.pendingSplitScrollState &&
      !pane.pendingDragScrollState &&
      !pane.pendingLayoutScrollState
    ) {
      pane.pendingLayoutScrollState = captureScrollState(pane.terminal)
    }
  }
}

export function unlockAllPaneScrollStates(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    if (pane.pendingLayoutScrollState) {
      try {
        restoreScrollState(pane.terminal, pane.pendingLayoutScrollState)
      } catch {
        /* ignore */
      }
      pane.pendingLayoutScrollState = null
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
