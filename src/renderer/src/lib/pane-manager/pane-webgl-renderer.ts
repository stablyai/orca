import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  getTerminalWebglAutoDecision,
  resetTerminalWebglAutoDecision
} from './terminal-webgl-auto-policy'

export const ENABLE_WEBGL_RENDERER = true
let suggestedRendererType: 'dom' | undefined

export function resetTerminalWebglSuggestion(): void {
  // Why: toggling GPU settings should let "auto" retry WebGL after an earlier
  // attach failure suggested DOM rendering for this app session.
  suggestedRendererType = undefined
  resetTerminalWebglAutoDecision()
}

export function shouldUseTerminalWebgl(pane: ManagedPaneInternal): boolean {
  if (pane.terminalGpuAcceleration === 'on') {
    return true
  }
  if (pane.terminalGpuAcceleration !== 'auto' || suggestedRendererType === 'dom') {
    return false
  }
  return getTerminalWebglAutoDecision().allowWebgl
}

function refreshTerminalAfterWebglAttach(pane: ManagedPaneInternal): void {
  try {
    // Why: a newly attached WebGL canvas starts empty; repaint immediately so
    // resume/reparent/settings toggles do not look frozen until new output.
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore - pane may have been disposed in the meantime */
  }
}

export function cancelPendingWebglRefresh(pane: ManagedPaneInternal): void {
  if (pane.pendingWebglRefreshRafId != null) {
    cancelAnimationFrame(pane.pendingWebglRefreshRafId)
    pane.pendingWebglRefreshRafId = null
  }
}

export function disposeWebgl(
  pane: ManagedPaneInternal,
  options?: { refreshDimensions?: boolean }
): void {
  cancelPendingWebglRefresh(pane)
  if (!pane.webglAddon) {
    return
  }
  try {
    pane.webglAddon.dispose()
  } catch {
    /* ignore */
  }
  pane.webglAddon = null
  if (options?.refreshDimensions) {
    // Why: DOM and WebGL renderer cell metrics differ after teardown. Without
    // a refit, Linux DOM scrollbars can desync and trigger visible reflow jitter.
    pane.pendingWebglRefreshRafId = requestAnimationFrame(() => {
      pane.pendingWebglRefreshRafId = null
      try {
        pane.fitAddon.fit()
        pane.terminal.refresh(0, pane.terminal.rows - 1)
      } catch {
        /* ignore — pane may have been disposed in the meantime */
      }
    })
  }
}

export function markComplexScriptOutput(pane: ManagedPaneInternal): void {
  pane.hasComplexScriptOutput = true
}

export function resetWebglTextureAtlas(pane: ManagedPaneInternal): void {
  if (!pane.webglAddon || pane.webglDisabledAfterContextLoss) {
    return
  }
  try {
    // Why: rapid TUI redraws can corrupt xterm's WebGL glyph atlas without a
    // context-loss event. Clearing the atlas preserves GPU rendering and forces
    // a fresh paint when the pane becomes visible/focused again.
    pane.webglAddon.clearTextureAtlas()
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore — pane may have been disposed in the meantime */
  }
}

export function attachWebgl(pane: ManagedPaneInternal): void {
  if (
    !ENABLE_WEBGL_RENDERER ||
    !pane.gpuRenderingEnabled ||
    !shouldUseTerminalWebgl(pane) ||
    pane.webglAttachmentDeferred ||
    pane.webglDisabledAfterContextLoss
  ) {
    pane.webglAddon = null
    return
  }
  try {
    const webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      console.warn(
        '[terminal] WebGL context lost for pane',
        pane.id,
        '— falling back to DOM renderer'
      )
      // Why: Chromium starts reclaiming terminal contexts under pressure.
      // Recreating WebGL for this pane can loop context loss and leave xterm
      // visually blank, so keep the pane on the DOM renderer until remount.
      pane.webglDisabledAfterContextLoss = true
      disposeWebgl(pane, { refreshDimensions: true })
    })
    pane.terminal.loadAddon(webglAddon)
    pane.webglAddon = webglAddon
    refreshTerminalAfterWebglAttach(pane)
  } catch (err) {
    if (pane.terminalGpuAcceleration === 'auto') {
      // Why: "auto" tries the faster renderer first, but one failed attach is
      // enough signal to keep new auto panes on DOM until the setting changes.
      suggestedRendererType = 'dom'
    }
    // WebGL not available — default DOM renderer is fine, but log it for debugging
    console.warn('[terminal] WebGL unavailable for pane', pane.id, '— using DOM renderer:', err)
    pane.webglAddon = null
  }
}
