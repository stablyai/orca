import type { Repo } from '../../../../shared/types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  shouldShowHostScopeControls,
  type SidebarHostOption
} from '../sidebar/sidebar-host-options'

export type PaletteHostBadge = {
  hostId: ExecutionHostId
  label: string
}

// Why: Cmd+J results only need a host label when more than one host exists; a
// local-only user gets no badge at all, so single-host UIs stay unchanged.
export function getPaletteHostBadge(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined,
  hostOptions: readonly SidebarHostOption[]
): PaletteHostBadge | null {
  if (!repo || !shouldShowHostScopeControls(hostOptions)) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  const host = hostOptions.find((option) => option.id === hostId)
  if (!host) {
    return null
  }
  return { hostId, label: host.label }
}
