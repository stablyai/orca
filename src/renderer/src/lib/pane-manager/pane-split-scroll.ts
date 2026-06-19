import type { IBuffer, IDisposable } from '@xterm/xterm'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { releaseScrollStateMarker, restoreScrollState } from './pane-scroll'

function refreshAfterReparent(pane: ManagedPaneInternal): void {
  try {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore — pane may have been disposed */
  }
}

function clearPendingSplitScrollBufferDisposable(pane: ManagedPaneInternal): void {
  pane.pendingSplitScrollBufferDisposable?.dispose()
  pane.pendingSplitScrollBufferDisposable = null
}

function cancelPendingSplitScrollHandles(pane: ManagedPaneInternal): void {
  clearPendingSplitScrollBufferDisposable(pane)
  if (typeof cancelAnimationFrame === 'function') {
    for (const rafId of pane.pendingSplitScrollRafIds ?? []) {
      cancelAnimationFrame(rafId)
    }
  }
  pane.pendingSplitScrollRafIds = []
  if (pane.pendingSplitScrollTimerId != null) {
    clearTimeout(pane.pendingSplitScrollTimerId)
    pane.pendingSplitScrollTimerId = null
  }
}

export function clearPendingSplitScrollRestore(pane: ManagedPaneInternal): void {
  cancelPendingSplitScrollHandles(pane)
  if (pane.pendingSplitScrollState) {
    releaseScrollStateMarker(pane.pendingSplitScrollState)
    pane.pendingSplitScrollState = null
  }
}

function runAfterNormalBuffer(
  pane: ManagedPaneInternal,
  getPaneById: (id: number) => ManagedPaneInternal | undefined,
  paneId: number,
  isDestroyed: () => boolean,
  callback: (pane: ManagedPaneInternal) => void
): void {
  clearPendingSplitScrollBufferDisposable(pane)
  let disposable: IDisposable | null = null
  disposable = pane.terminal.buffer.onBufferChange((buffer: IBuffer) => {
    if (buffer.type === 'alternate') {
      return
    }
    if (pane.pendingSplitScrollBufferDisposable === disposable) {
      pane.pendingSplitScrollBufferDisposable = null
    }
    disposable?.dispose()
    disposable = null
    if (isDestroyed()) {
      return
    }
    const live = getPaneById(paneId)
    if (live) {
      callback(live)
    }
  })
  pane.pendingSplitScrollBufferDisposable = disposable
}

function restoreCapturedScrollState(
  pane: ManagedPaneInternal,
  scrollState: ScrollState,
  reattachWebgl?: (pane: ManagedPaneInternal) => void
): void {
  clearPendingSplitScrollBufferDisposable(pane)
  pane.pendingSplitScrollState = null
  if (reattachWebgl) {
    reattachWebgl(pane)
  }
  restoreScrollState(pane.terminal, scrollState)
  refreshAfterReparent(pane)
}

// Why: reparenting a terminal container during split resets the viewport
// scroll position (browser clears scrollTop on DOM move). This schedules a
// two-phase restore: an early double-rAF (~32ms) to minimise the visible
// flash, plus a 200ms authoritative restore that also clears the scroll lock.
//
// The optional reattachWebgl callback re-creates the WebGL addon after the
// DOM has settled. splitPane() disposes WebGL before wrapInSplit() to free
// the GPU context slot (Chromium silently kills the oldest context when
// approaching its limit without firing contextlost). Reattaching at 200ms
// — after all layout and reflow have completed — creates a fresh context on
// a stable DOM tree.
export function scheduleSplitScrollRestore(
  getPaneById: (id: number) => ManagedPaneInternal | undefined,
  paneId: number,
  scrollState: ScrollState,
  isDestroyed: () => boolean,
  reattachWebgl?: (pane: ManagedPaneInternal) => void
): void {
  const scheduledPane = getPaneById(paneId)
  if (scheduledPane) {
    cancelPendingSplitScrollHandles(scheduledPane)
  }

  const firstRafId = requestAnimationFrame(() => {
    const liveAfterFirstFrame = getPaneById(paneId)
    const secondRafId = requestAnimationFrame(() => {
      const live = getPaneById(paneId)
      if (live) {
        live.pendingSplitScrollRafIds = []
      }
      if (isDestroyed()) {
        return
      }
      if (!live?.pendingSplitScrollState) {
        return
      }
      // Why: see the 200ms timer below — the alt-screen buffer belongs to a
      // TUI and restore-during-draw knocks its cursor one row off (#1298).
      if (
        scrollState.bufferType === 'alternate' ||
        live.terminal.buffer.active.type === 'alternate'
      ) {
        return
      }
      restoreScrollState(live.terminal, scrollState)
      refreshAfterReparent(live)
    })
    if (liveAfterFirstFrame) {
      liveAfterFirstFrame.pendingSplitScrollRafIds = [
        ...(liveAfterFirstFrame.pendingSplitScrollRafIds ?? []),
        secondRafId
      ]
    }
  })
  if (scheduledPane) {
    scheduledPane.pendingSplitScrollRafIds = [firstRafId]
  }

  const settleTimerId = setTimeout(() => {
    const live = getPaneById(paneId)
    if (live?.pendingSplitScrollTimerId === settleTimerId) {
      live.pendingSplitScrollTimerId = null
      live.pendingSplitScrollRafIds = []
    }
    if (isDestroyed()) {
      return
    }
    if (!live) {
      return
    }
    // Why: the alt-screen buffer belongs to a full-screen TUI (Claude Code,
    // vim, less) that owns its cursor position. Re-running scroll restore
    // and a full refresh here clobbers an in-progress draw — refresh(0,
    // rows-1) repaints rows from xterm's buffer, racing the TUI's next
    // write and leaving its cursor one row off (#1298 regression).
    // WebGL reattach also refreshes, so defer it until the TUI exits the
    // alternate buffer. Alt-screen has no scrollback, so scroll restore has
    // nothing legitimate to do.
    if (scrollState.bufferType === 'alternate') {
      clearPendingSplitScrollBufferDisposable(live)
      live.pendingSplitScrollState = null
      if (live.terminal.buffer.active.type === 'alternate' && reattachWebgl) {
        runAfterNormalBuffer(live, getPaneById, paneId, isDestroyed, reattachWebgl)
        return
      }
      if (reattachWebgl) {
        reattachWebgl(live)
      }
      return
    }
    if (live.terminal.buffer.active.type === 'alternate') {
      runAfterNormalBuffer(live, getPaneById, paneId, isDestroyed, (normalPane) => {
        restoreCapturedScrollState(normalPane, scrollState, reattachWebgl)
      })
      return
    }
    restoreCapturedScrollState(live, scrollState, reattachWebgl)
  }, 200)
  if (scheduledPane) {
    scheduledPane.pendingSplitScrollTimerId = settleTimerId
  }
}
