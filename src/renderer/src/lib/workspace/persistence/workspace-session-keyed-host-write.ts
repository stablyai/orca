import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId as normalizeWorkspaceSessionKeyToWorktreeId } from '../../../../../shared/workspace/identity/workspace-scope'
import { contestedPartitionHosts } from '../../../../../shared/workspace-session/workspace-session-contested-primary-host'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'
import type {
  AcknowledgedWorkspaceSessionEntries,
  WorkspaceSessionEntriesDiff,
  WorkspaceSessionFieldEntries
} from './workspace-session-acknowledged-entries'
import { sendHostEntries } from './workspace-session-host-entries-write'
import type { HostPersistenceState, SessionApi } from './workspace-session-host-persistence'
import { sessionRoutingFor, type HostSessionRouting } from './workspace-session-host-routing'
import type { WorkspaceSessionKeyedWrite } from './workspace-session-keyed-write'
import { settleSessionWrites, type SessionWriteOutcome } from './desktop-relay-write-plan'

/** Whether a workspace is claimed by more than one partition, or has rows parked on another host:
 *  only the whole path restores parked rows. (The restored-primary map names every restored key, so
 *  it says nothing about contention.) */
function isContestedWorkspace(
  state: HostPersistenceState,
  routing: HostSessionRouting,
  field: string,
  worktreeId: string
): boolean {
  const rawWorktreeId = normalizeWorkspaceSessionKeyToWorktreeId(worktreeId)
  if (contestedPartitionHosts(routing.claims.get(rawWorktreeId) ?? []).length > 1) {
    return true
  }
  return Object.values(state.contestedHostWorkspaceSessions ?? {}).some((slice) => {
    const parkedFields: Record<string, unknown> = slice ?? {}
    const parked = parkedFields[field]
    return isWorkspaceSessionRecord(parked) && Object.hasOwn(parked, worktreeId)
  })
}

/** Whether a keyed write of `fields` could be sent at all, checked before it is built: the client
 *  takes entries patches and main holds the whole path's output for those fields. */
export function keyedSessionWriteReady(
  api: SessionApi,
  state: HostPersistenceState,
  acknowledged: AcknowledgedWorkspaceSessionEntries,
  fields: readonly string[]
): boolean {
  return Boolean(api.patchEntries) && acknowledged.isSettled(sessionRoutingFor(state), fields)
}

/** Send only the keys a keyed write rebuilt, to the hosts the whole path last wrote for its inputs.
 *  Null when that can't equal the whole path's write: routing changed or main may not hold the
 *  rest of the inputs' output, a key is contested, or a host hasn't acknowledged a field. */
export function patchWorkspaceSessionEntriesByHost(
  api: SessionApi,
  write: WorkspaceSessionKeyedWrite,
  state: HostPersistenceState,
  acknowledged: AcknowledgedWorkspaceSessionEntries
): { written: Promise<SessionWriteOutcome | void> } | null {
  const { patchEntries } = api
  if (!patchEntries) {
    return null
  }
  const routing = sessionRoutingFor(state)
  const hostIds = acknowledged.settledHosts(routing, write.fields)
  if (!hostIds) {
    return null
  }
  const entriesByHost = new Map<ExecutionHostId, WorkspaceSessionFieldEntries>()
  for (const [field, values] of Object.entries(write.entries)) {
    for (const [worktreeId, value] of Object.entries(values)) {
      const hostId = routing.hostIdByWorktreeId(worktreeId)
      if (!hostIds.has(hostId) || isContestedWorkspace(state, routing, field, worktreeId)) {
        return null
      }
      let entries = entriesByHost.get(hostId)
      if (!entries) {
        entries = {}
        entriesByHost.set(hostId, entries)
      }
      const target = (entries[field] ??= {})
      target[worktreeId] = value
    }
  }
  const diffs: [ExecutionHostId, WorkspaceSessionEntriesDiff][] = []
  for (const hostId of hostIds) {
    const diff = acknowledged.diffEntries(hostId, entriesByHost.get(hostId) ?? {})
    if (!diff) {
      return null
    }
    diffs.push([hostId, diff])
  }
  const writes = diffs.map(([hostId, diff]) =>
    sendHostEntries(patchEntries, diff, hostId, acknowledged)
  )
  return { written: settleSessionWrites(writes, null) }
}
