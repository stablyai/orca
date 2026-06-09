import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl, disposeWebgl } from './pane-webgl-renderer'

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
  attachWebgl(pane)
}
