import type { WorkspacePort } from '../../../shared/workspace-ports'

/**
 * What a port row shows for the process behind the listener.
 *
 * A recognized dev server takes the primary slot, because "Vite" answers the
 * question a row of `node` never could. The raw process name is not discarded:
 * it moves to `detail` so it stays reachable for debugging.
 */
export type WorkspacePortProcessLabel = {
  /** Primary text: the dev server when recognized, otherwise the process. */
  label: string
  /** Raw process name, set only when a dev server label displaced it. */
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
