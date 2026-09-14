import type { ManagedPaneInternal, PaneRenderingDiagnostics } from './pane-manager-types'
import { getTerminalWebglAutoDecision } from './terminal-webgl-auto-policy'
import { countPaneWebglContextLosses } from './pane-webgl-context-loss-policy'

export function collectPaneRenderingDiagnostics(
  panes: Map<number, ManagedPaneInternal>
): PaneRenderingDiagnostics[] {
  return Array.from(panes.values()).map((pane) => ({
    paneId: pane.id,
    terminalGpuAcceleration: pane.terminalGpuAcceleration,
    gpuRenderingEnabled: pane.gpuRenderingEnabled,
    webglAttachmentDeferred: pane.webglAttachmentDeferred,
    webglDisabledAfterContextLoss: pane.webglDisabledAfterContextLoss,
    webglContextLossesInWindow: countPaneWebglContextLosses(pane),
    webglAttachFailedSinceRecovery: pane.webglAttachFailedSinceRecovery === true,
    hasComplexScriptOutput: pane.hasComplexScriptOutput,
    terminalWebglAutoDecision: getTerminalWebglAutoDecision(),
    hasWebgl: Boolean(pane.webglAddon)
  }))
}
