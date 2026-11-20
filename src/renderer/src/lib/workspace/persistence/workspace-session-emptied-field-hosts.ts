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

// Restart reconnects from these; an ended last relay left on an SSH partition revived after a crash.
const SSH_RECONNECT_FIELDS = [
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

/** A reconnect field only routes the entries it still has, so an SSH host whose last relay ended got no
 *  save for it and main kept the ended one. A host main acknowledged entries from this window for gets
 *  the field empty, and the entries diff then removes exactly those keys; a partition this window never
 *  wrote (unread, another writer's) is left alone, and a host with parked contested rows is skipped. */
export function clearEndedSshReconnectFacts(
  slices: HostSessionSlices,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState,
  acknowledged: AcknowledgedWorkspaceSessionEntries
): void {
  let catalog: Set<ExecutionHostId> | null = null
  for (const field of SSH_RECONNECT_FIELDS) {
    if (patch[field] === undefined) {
      continue
    }
    for (const hostId of acknowledged.hostsHoldingEntries(field)) {
      if (
        parseExecutionHostId(hostId)?.kind !== 'ssh' ||
        state.contestedHostWorkspaceSessions?.[hostId] ||
        slices[hostId]?.[field] !== undefined
      ) {
        continue
      }
      catalog ??= catalogHostIds(state)
      if (!catalog.has(hostId)) {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partition patch carries only the fields it names; main keeps the rest.
      const slice = (slices[hostId] ??= {} as WorkspaceSessionState)
      Object.assign(slice, { [field]: field === 'remoteSessionIdsByTabId' ? {} : [] })
    }
  }
}
