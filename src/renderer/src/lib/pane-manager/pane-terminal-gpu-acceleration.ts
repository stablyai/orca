import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { attachWebgl, disposeWebgl, resetTerminalWebglSuggestion } from './pane-webgl-renderer'
import { safeFit } from './pane-tree-ops'

export function applyTerminalGpuAcceleration(
  panes: Iterable<ManagedPaneInternal>,
  options: PaneManagerOptions,
  mode: PaneManagerOptions['terminalGpuAcceleration']
): void {
  const nextMode = mode ?? 'auto'
  const previousMode = options.terminalGpuAcceleration ?? 'auto'
  options.terminalGpuAcceleration = nextMode
  if (previousMode !== nextMode) {
    resetTerminalWebglSuggestion()
  }
  for (const pane of panes) {
    pane.terminalGpuAcceleration = nextMode
    if (nextMode === 'off' || (nextMode === 'auto' && pane.hasComplexScriptOutput)) {
      disposeWebgl(pane, { refreshDimensions: true })
      continue
    }
    if (
      pane.gpuRenderingEnabled &&
      !pane.webglAddon &&
      !pane.webglAttachmentDeferred &&
      !pane.webglDisabledAfterContextLoss &&
      (nextMode === 'on' || !pane.hasComplexScriptOutput)
    ) {
      attachWebgl(pane)
      safeFit(pane)
    }
  }
}
