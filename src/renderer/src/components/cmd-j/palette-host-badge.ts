import type { Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'

export type PaletteHostBadge = {
  hostId: ExecutionHostId
  label: string
}

// Why: Cmd+J only needs a host label when there's a live remote to disambiguate
// from. A merely-configured-but-disconnected SSH/runtime host shouldn't tag every
// row with "Local Mac", so we require an actually-reachable non-local host —
// unlike the sidebar gate, which lists disconnected hosts so users can connect.
function hasActiveRemoteHost(hostOptions: readonly SidebarHostOption[]): boolean {
  return hostOptions.some(
    (host) => host.id !== LOCAL_EXECUTION_HOST_ID && host.health !== 'disconnected'
  )
}

export function getPaletteHostBadge(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined,
  hostOptions: readonly SidebarHostOption[]
): PaletteHostBadge | null {
  if (!repo || !hasActiveRemoteHost(hostOptions)) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  const host = hostOptions.find((option) => option.id === hostId)
  if (!host) {
    return null
  }
  return { hostId, label: host.label }
}
