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

// Why: SIGWINCH settling delay. After the drag ends we flush the suppressed
// PTY resize, which sends SIGWINCH to the shell. Interactive TUIs (Claude
// Code / Ink) redraw on SIGWINCH, writing cursor-positioned content that
// moves xterm's viewportY. If we clear pendingDragScrollState immediately,
// the ResizeObserver's captureAllPaneScrollStates runs against the corrupted
// viewportY and cements the wrong position. Keeping the lock active for
// this period makes captureAllPaneScrollStates skip the pane and makes
// safeFit / fitAllPanesInternal restore from the original captured state.
const SIGWINCH_SETTLE_MS = 500

export function unlockDragScroll(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of findManagedPanesUnder(el, panes)) {
    if (pane.pendingDragScrollState) {
      const originalState = pane.pendingDragScrollState

      try {
        restoreScrollState(pane.terminal, originalState)
      } catch {
        /* ignore */
      }

      // Why: during divider drag, PTY resize is suppressed to prevent
      // SIGWINCH-driven redraws from corrupting scroll state. Dispatch
      // on the pane container so pty-connection.ts can flush the final
      // dimensions to the PTY when the drag ends.
      pane.container.dispatchEvent(new CustomEvent('pane-drag-end'))

      // Why: the PTY resize we just flushed causes SIGWINCH → Claude
      // Code / Ink redraws → viewportY corruption. We keep the lock
      // and actively restore scroll every frame during the settling
      // period so the user never sees the viewport jump. Without this,
      // there is a visible flash where the viewport jumps to line 0
      // before the settling timeout fires.
      startSettlingLoop(pane, originalState)
    }
  }
}

function startSettlingLoop(pane: ManagedPaneInternal, originalState: ScrollState): void {
  let rafId: number | null = null

  const restoreFrame = (): void => {
    if (pane.pendingDragScrollState !== originalState) {
      return
    }
    try {
      restoreScrollState(pane.terminal, originalState)
    } catch {
      /* ignore */
    }
    rafId = requestAnimationFrame(restoreFrame)
  }
  rafId = requestAnimationFrame(restoreFrame)

  setTimeout(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
    }
    if (pane.pendingDragScrollState === originalState) {
      try {
        restoreScrollState(pane.terminal, originalState)
      } catch {
        /* ignore */
      }
      pane.pendingDragScrollState = null
      // Why: during the settling period isPaneDragResizing was true,
      // so any terminal.onResize events were suppressed and stored as
      // pending. Dispatch pane-drag-end again so pty-connection.ts
      // flushes any accumulated resize to the PTY.
      pane.container.dispatchEvent(new CustomEvent('pane-drag-end'))
    }
  }, SIGWINCH_SETTLE_MS)
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
      const originalState = pane.pendingLayoutScrollState

      try {
        restoreScrollState(pane.terminal, originalState)
      } catch {
        /* ignore */
      }

      // Why: PTY resize is NOT suppressed during layout changes (unlike
      // drag), so SIGWINCH fires immediately when fit() runs. Interactive
      // TUIs (Claude Code / Ink) redraw on SIGWINCH, corrupting viewportY.
      // The settling loop restores scroll every frame for 500ms, absorbing
      // these redraws. The lock stays active so fitAllPanesInternal
      // continues using the original captured state during settling.
      startLayoutSettlingLoop(pane, originalState)
    }
  }
}

function startLayoutSettlingLoop(pane: ManagedPaneInternal, originalState: ScrollState): void {
  let rafId: number | null = null

  const restoreFrame = (): void => {
    if (pane.pendingLayoutScrollState !== originalState) {
      return
    }
    try {
      restoreScrollState(pane.terminal, originalState)
    } catch {
      /* ignore */
    }
    rafId = requestAnimationFrame(restoreFrame)
  }
  rafId = requestAnimationFrame(restoreFrame)

  setTimeout(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
    }
    if (pane.pendingLayoutScrollState === originalState) {
      try {
        restoreScrollState(pane.terminal, originalState)
      } catch {
        /* ignore */
      }
      pane.pendingLayoutScrollState = null
    }
  }, SIGWINCH_SETTLE_MS)
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
