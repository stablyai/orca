import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'

export const ENABLE_WEBGL_RENDERER = true
let suggestedRendererType: 'dom' | undefined

export function resetTerminalWebglSuggestion(): void {
  // Why: VS Code clears its suggested renderer when gpuAcceleration changes,
  // letting "auto" retry WebGL after a user toggles the setting.
  suggestedRendererType = undefined
}

function shouldUseWebgl(pane: ManagedPaneInternal): boolean {
  if (pane.terminalGpuAcceleration === 'on') {
    return true
  }
  return (
    pane.terminalGpuAcceleration === 'auto' &&
    suggestedRendererType === undefined &&
    !pane.hasComplexScriptOutput
  )
}

export function disposeWebgl(
  pane: ManagedPaneInternal,
  options?: { refreshDimensions?: boolean }
): void {
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
    // Why: VS Code refreshes terminal dimensions after WebGL teardown because
    // DOM and WebGL renderer cell metrics differ. Without this, Linux DOM
    // scrollbars can desync and trigger visible reflow jitter.
    requestAnimationFrame(() => {
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
  if (pane.terminalGpuAcceleration !== 'auto') {
    return
  }
  disposeWebgl(pane, { refreshDimensions: true })
}

export function attachWebgl(pane: ManagedPaneInternal): void {
  if (
    !ENABLE_WEBGL_RENDERER ||
    !pane.gpuRenderingEnabled ||
    !shouldUseWebgl(pane) ||
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
  } catch (err) {
    if (pane.terminalGpuAcceleration === 'auto') {
      // Why: mirrors VS Code's `terminal.integrated.gpuAcceleration=auto`
      // behavior: once WebGL fails, keep subsequent auto panes on DOM until
      // the setting changes and resets the suggestion.
      suggestedRendererType = 'dom'
    }
    // WebGL not available — default DOM renderer is fine, but log it for debugging
    console.warn('[terminal] WebGL unavailable for pane', pane.id, '— using DOM renderer:', err)
    pane.webglAddon = null
  }
}
