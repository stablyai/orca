import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { HostSessionWriteMode } from './workspace-session-host-contention'
import type { HostPersistenceState } from './workspace-session-host-persistence'

// Restart reconnects from these; an ended last relay left on an SSH partition revived after a crash.
const SSH_PARTITION_EMPTIED_FIELDS = new Set<keyof WorkspaceSessionState>([
  'remoteSessionIdsByTabId',
  'activeWorktreeIdsOnShutdown'
])

/** Hosts that get a field the write carries as empty when none of their workspaces has an entry left:
 *  main patches fieldwise, so without it their stale rows stay. Only a partition this window loaded and
 *  still catalogs is one its state speaks for; the contested shadow restores only worktree-keyed rows,
 *  so a host holding parked rows is left out. SSH partitions get only the reconnect facts: another
 *  window's rows in their other fields are not this window's to clear. */
export function emptiedFieldHostIds(
  state: HostPersistenceState,
  mode: HostSessionWriteMode
): (field: keyof WorkspaceSessionState) => readonly ExecutionHostId[] {
  if (mode !== 'patch') {
    return () => []
  }
  const catalogHostIds = new Set(state.repos.map((repo) => getRepoExecutionHostId(repo)))
  const speaksFor = (hostIds: readonly ExecutionHostId[] | undefined) =>
    (hostIds ?? []).filter(
      (hostId) => catalogHostIds.has(hostId) && !state.contestedHostWorkspaceSessions?.[hostId]
    )
  const runtimeHostIds = speaksFor(state.hydratedRuntimeSessionHostIds)
  const withSsh = [...runtimeHostIds, ...speaksFor(state.hydratedSshSessionHostIds)]
  return (field) => (SSH_PARTITION_EMPTIED_FIELDS.has(field) ? withSsh : runtimeHostIds)
}
