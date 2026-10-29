import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'

export type PaletteHostBadge = {
  hostId: ExecutionHostId
  label: string
}

// Show unfiltered host labels only with a reachable remote; sidebar headers also list disconnected hosts for connection.
function hasActiveRemoteHost(hostOptions: readonly SidebarHostOption[]): boolean {
  return hostOptions.some(
    (host) => host.id !== LOCAL_EXECUTION_HOST_ID && host.health === 'available'
  )
}

export function getPaletteHostBadge(
  hostId: ExecutionHostId | null | undefined,
  hostOptions: readonly SidebarHostOption[],
  // Filtered rows need their host label to explain inclusion even while every remote is disconnected.
  alwaysShowHostLabel = false
): PaletteHostBadge | null {
  if (!alwaysShowHostLabel && !hasActiveRemoteHost(hostOptions)) {
    return null
  }
  const host = hostOptions.find((option) => option.id === hostId)
  if (!host) {
    return null
  }
  return { hostId: host.id, label: host.label }
}
