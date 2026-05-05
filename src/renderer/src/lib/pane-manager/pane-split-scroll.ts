import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { restoreScrollState } from './pane-scroll'

function refreshAfterReparent(pane: ManagedPaneInternal): void {
  try {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore — pane may have been disposed */
  }
}

function logPaneHealth(pane: ManagedPaneInternal, phase: string): void {
  const canvases = pane.container.querySelectorAll('canvas')
  const canvasInfo = Array.from(canvases).map((c) => {
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    return {
      w: c.width,
      h: c.height,
      inDOM: c.isConnected,
      ctxLost: gl ? gl.isContextLost() : 'no-ctx'
    }
  })
  const content = pane.serializeAddon?.serialize?.() ?? ''
  // oxlint-disable-next-line no-control-regex
  const stripped = content.replace(/[\s\x00-\x1f]/g, '')
  const info = {
    phase,
    paneId: pane.id,
    webgl: !!pane.webglAddon,
    webglDeferred: pane.webglAttachmentDeferred,
    webglDisabled: pane.webglDisabledAfterContextLoss,
    canvases: canvasInfo,
    contentLen: stripped.length,
    bufferLines: pane.terminal.buffer.active.length
  }
  const hasBufferData = pane.terminal.buffer.active.length > pane.terminal.rows
  if (stripped.length === 0 && hasBufferData) {
    console.error(
      '[split-diag] DEAD TERMINAL — pane',
      pane.id,
      pane.debugLabel ?? '',
      'has buffer data but no rendered content at',
      phase,
      info
    )
  } else if (stripped.length === 0) {
    console.log(
      '[split-diag] pane',
      pane.id,
      pane.debugLabel ?? '',
      'no content yet at',
      phase,
      '(PTY likely still spawning)'
    )
  } else {
    console.log(
      '[split-diag] pane',
      pane.id,
      pane.debugLabel ?? '',
      'healthy at',
      phase,
      '— content:',
      stripped.length
    )
  }
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
    if (reattachWebgl) {
      reattachWebgl(live)
    }
    restoreScrollState(live.terminal, scrollState)
    refreshAfterReparent(live)
  }, 200)

  setTimeout(() => {
    if (isDestroyed()) {
      return
    }
    const live = getPaneById(paneId)
    // Skip suspended panes — they have no WebGL/content by design.
    if (live && !live.webglAttachmentDeferred) {
      logPaneHealth(live, '1s-health-check')
    }
  }, 1000)
}
