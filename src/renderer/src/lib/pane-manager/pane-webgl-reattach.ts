import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl, clearTerminalWebglAttachBackoff, disposeWebgl } from './pane-webgl-renderer'

export function reattachWebglIfNeeded(pane: ManagedPaneInternal): void {
  if (pane.gpuRenderingEnabled && !pane.webglAddon && !pane.webglDisabledAfterContextLoss) {
    attachWebgl(pane)
  }
}

export function rebuildAttachedWebgl(pane: ManagedPaneInternal): void {
  if (!pane.webglAddon || pane.webglDisabledAfterContextLoss) {
    return
  }
  disposeWebgl(pane)
  // Why: the live addon just proved context creation works, so a stale attach
  // backoff from an earlier failure must not downgrade this pane to DOM.
  clearTerminalWebglAttachBackoff()
  attachWebgl(pane)
}
