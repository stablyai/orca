import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import type { HostSessionSlices } from './workspace-session-host-split'
import type { HostPersistenceState, SessionApi } from './workspace-session-host-persistence'

/** Hosts this window can still write: its catalogs' owners, hydrated partitions and this write's. */
export function routedSessionHostIds(
  state: HostPersistenceState,
  slices: HostSessionSlices
): Set<ExecutionHostId> {
  const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
  for (const key of Object.keys(slices)) {
    const hostId = normalizeExecutionHostId(key)
    if (hostId) {
      hostIds.add(hostId)
    }
  }
  for (const repo of state.repos) {
    hostIds.add(getRepoExecutionHostId(repo))
  }
  for (const hostId of state.hydratedRuntimeSessionHostIds ?? []) {
    hostIds.add(hostId)
  }
  for (const owner of [...(selectFolderWorkspaces(state) ?? []), ...(state.projectGroups ?? [])]) {
    const parsed = parseExecutionHostId(owner.executionHostId)
    if (parsed) {
      hostIds.add(parsed.id)
    }
  }
  return hostIds
}

/** One partition's write: only the entries main hasn't acknowledged when it supports that, else
 *  the whole fields. A failed or fenced write forgets main's copy so the next one goes whole. */
export function patchHostSlice(
  api: SessionApi,
  slice: WorkspaceSessionPatch,
  hostId: ExecutionHostId,
  acknowledged: AcknowledgedWorkspaceSessionEntries | undefined
): Promise<void> {
  const target = hostId === LOCAL_EXECUTION_HOST_ID ? undefined : hostId
  if (!acknowledged || !api.patchEntries) {
    return api.patch(slice, target)
  }
  const { patch, acknowledge } = acknowledged.diff(hostId, slice)
  // Sent even when empty: main's unchanged-save handling still has to see this partition's save.
  return api.patchEntries(patch, target).then(
    (result) => {
      if (result.status === 'skipped') {
        acknowledged.forget(hostId)
        return
      }
      acknowledge()
      if (result.normalizedFields?.length) {
        acknowledged.forget(hostId, result.normalizedFields)
      }
    },
    (error: unknown) => {
      acknowledged.forget(hostId)
      throw error
    }
  )
}
