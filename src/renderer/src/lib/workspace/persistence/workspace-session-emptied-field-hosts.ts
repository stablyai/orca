import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import type { HostPersistenceState } from './workspace-session-host-persistence'
import type { HostSessionSlices } from './workspace-session-host-split'

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

/** Restart reattaches the relay ids in remoteSessionIdsByTabId. The field only routes the entries it
 *  still has, so an SSH host whose last relay ended got no save for it and main kept the ended one. A host
 *  this window sent entries to gets the field empty, and the entries diff then removes exactly the keys
 *  it sent (main or another writer's keys stay); a partition this window never wrote (unread, or rows
 *  from before this run) is left alone, and a host with parked contested rows is skipped. The
 *  activeWorktreeIdsOnShutdown array is not cleared this way: arrays go whole, and main appends to it. */
export function clearEndedSshReconnectFacts(
  slices: HostSessionSlices,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState,
  acknowledged: AcknowledgedWorkspaceSessionEntries
): void {
  if (patch.remoteSessionIdsByTabId === undefined) {
    return
  }
  let catalog: Set<ExecutionHostId> | null = null
  for (const hostId of acknowledged.hostsHoldingEntries('remoteSessionIdsByTabId')) {
    if (
      parseExecutionHostId(hostId)?.kind !== 'ssh' ||
      state.contestedHostWorkspaceSessions?.[hostId] ||
      slices[hostId]?.remoteSessionIdsByTabId !== undefined
    ) {
      continue
    }
    catalog ??= catalogHostIds(state)
    if (!catalog.has(hostId)) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partition patch carries only the fields it names; main keeps the rest.
    const slice = (slices[hostId] ??= {} as WorkspaceSessionState)
    slice.remoteSessionIdsByTabId = {}
  }
}
