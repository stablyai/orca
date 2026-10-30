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

// Reparenting clears scrollTop. Restore after double-rAF (~32ms), then authoritatively at 200ms and unlock. Reattach WebGL only after stable layout; disposal before moving frees context slots Chromium could otherwise kill silently.
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
      // Alt-screen TUIs own cursor position; restoring during drawing shifts it one row (#1298), as guarded by the 200ms timer below.
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
    // Alt-screen TUIs own cursor position and have no scrollback; restore/refresh races their drawing (#1298). Defer WebGL reattach too, since it refreshes, until the alternate buffer exits.
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
