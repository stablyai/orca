import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl } from './pane-webgl-renderer'

export function reattachWebglIfNeeded(pane: ManagedPaneInternal): void {
  if (pane.gpuRenderingEnabled && !pane.webglAddon && !pane.webglDisabledAfterContextLoss) {
    attachWebgl(pane)
  }
}
