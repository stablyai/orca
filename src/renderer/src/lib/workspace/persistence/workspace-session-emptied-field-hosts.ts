import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { HostSessionWriteMode } from './workspace-session-host-contention'
import type { HostPersistenceState } from './workspace-session-host-persistence'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'

// Restart reconnects from these; an ended last relay left on an SSH partition revived after a crash.
const SSH_EMPTIED_RECONNECT_FIELDS = [
  'remoteSessionIdsByTabId',
  'activeWorktreeIdsOnShutdown'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

function catalogHostIds(state: HostPersistenceState): Set<ExecutionHostId> {
  const hostIds = new Set<ExecutionHostId>(state.repos.map((repo) => getRepoExecutionHostId(repo)))
  for (const owner of [...(selectFolderWorkspaces(state) ?? []), ...(state.projectGroups ?? [])]) {
    const parsed = parseExecutionHostId(owner.executionHostId)
    if (parsed) {
      hostIds.add(parsed.id)
    }
  }
  return hostIds
}

/** Main patches fieldwise, so an SSH partition whose last relay ended kept it unless the write carried
 *  the emptied field there. Only partitions this write already saves to get them, so idle hosts see no
 *  extra save; a host holding parked contested rows is left out, since its shadow restores only
 *  worktree-keyed rows. */
export function seedEmptiedSshReconnectFacts(
  slices: HostSessionSlices,
  payload: WorkspaceSessionState,
  state: HostPersistenceState,
  mode: HostSessionWriteMode
): void {
  const carried = SSH_EMPTIED_RECONNECT_FIELDS.filter((field) => payload[field] !== undefined)
  if (mode !== 'patch' || carried.length === 0) {
    return
  }
  const catalog = catalogHostIds(state)
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    if (
      parseExecutionHostId(hostId)?.kind !== 'ssh' ||
      !catalog.has(hostId) ||
      state.contestedHostWorkspaceSessions?.[hostId]
    ) {
      continue
    }
    if (carried.includes('remoteSessionIdsByTabId')) {
      slice.remoteSessionIdsByTabId ??= {}
    }
    if (carried.includes('activeWorktreeIdsOnShutdown')) {
      slice.activeWorktreeIdsOnShutdown ??= []
    }
  }
}
