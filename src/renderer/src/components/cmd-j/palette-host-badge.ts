import type { Repo } from '../../../../shared/repo-types'
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

function hasActiveRemoteHost(hostOptions: readonly SidebarHostOption[]): boolean {
  return hostOptions.some(
    (host) => host.id !== LOCAL_EXECUTION_HOST_ID && host.health !== 'disconnected'
  )
}

export function getPaletteHostBadge(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined,
  hostOptions: readonly SidebarHostOption[],
  { force = false }: { force?: boolean } = {}
): PaletteHostBadge | null {
  if (!repo || (!force && !hasActiveRemoteHost(hostOptions))) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  const host = hostOptions.find((option) => option.id === hostId)
  if (!host) {
    return null
  }
  return { hostId, label: host.label }
}
