import type { RuntimeStatus } from './runtime-types'

// Reachable status does not prove workspace work can run after a headed window closes. Require a non-ready
// graph plus absent live window; graph-ready headless and legacy hosts without window status remain usable (#6844).
export function isRuntimeWorkspaceWindowClosed(status: RuntimeStatus | null | undefined): boolean {
  if (!status) {
    return false
  }
  return status.graphStatus !== 'ready' && status.desktopWindowStatus === 'openable'
}
