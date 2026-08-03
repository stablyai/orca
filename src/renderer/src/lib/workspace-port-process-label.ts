import type { WorkspacePort } from '../../../shared/workspace-ports'

/** A recognized dev server takes `label` and demotes the raw process name to `detail`. */
export type WorkspacePortProcessLabel = {
  label: string
  detail?: string
}

export function getWorkspacePortProcessLabel(
  port: Pick<WorkspacePort, 'devServer' | 'processName' | 'pid'>
): WorkspacePortProcessLabel {
  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  if (!port.devServer) {
    return { label: processLabel }
  }
  // Why the equality guard: when the process name already is the product name
  // (`hugo`, `puma`), repeating it as a tooltip detail is noise.
  const detail =
    port.processName && port.processName.toLowerCase() !== port.devServer.label.toLowerCase()
      ? port.processName
      : undefined
  return { label: port.devServer.label, ...(detail ? { detail } : {}) }
}

/** Single-line form for tooltips and `title` attributes: `Vite — node`. */
export function formatWorkspacePortProcessTooltip(labelled: WorkspacePortProcessLabel): string {
  return labelled.detail ? `${labelled.label} — ${labelled.detail}` : labelled.label
}
