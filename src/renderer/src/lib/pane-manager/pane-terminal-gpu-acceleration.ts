import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import {
  attachWebgl,
  disposeWebgl,
  resetTerminalWebglSuggestion,
  shouldUseTerminalWebgl
} from './pane-webgl-renderer'
import { safeFit } from './pane-tree-ops'

export function applyTerminalGpuAcceleration(
  panes: Iterable<ManagedPaneInternal>,
  options: PaneManagerOptions,
  mode: PaneManagerOptions['terminalGpuAcceleration']
): void {
  const nextMode = mode ?? 'auto'
  const previousMode = options.terminalGpuAcceleration ?? 'auto'
  const modeChanged = previousMode !== nextMode
  options.terminalGpuAcceleration = nextMode
  if (modeChanged) {
    resetTerminalWebglSuggestion()
  }
  for (const pane of panes) {
    pane.terminalGpuAcceleration = nextMode
    if (modeChanged) {
      // Why: an explicit setting change is user intent to re-evaluate the
      // renderer; context-loss latches from the old mode should not pin DOM.
      pane.webglDisabledAfterContextLoss = false
    }
    if (!shouldUseTerminalWebgl(pane)) {
      disposeWebgl(pane, { refreshDimensions: true })
      continue
    }
    if (
      pane.gpuRenderingEnabled &&
      !pane.webglAddon &&
      !pane.webglAttachmentDeferred &&
      !pane.webglDisabledAfterContextLoss
    ) {
      attachWebgl(pane)
      safeFit(pane)
    }
  }
}
