import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionEntriesPatchResult } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { DesktopRelayWrite } from '../../../../../shared/workspace-session/desktop-relay-write'
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
  state: Pick<
    HostPersistenceState,
    'repos' | 'hydratedRuntimeSessionHostIds' | 'folderWorkspaces' | 'projectGroups'
  >,
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

/** How main took relay ids sent with a partition's entries; absent when none were sent. */
export type CarriedRelayStatus = {
  hostId: ExecutionHostId
  relays: NonNullable<WorkspaceSessionEntriesPatchResult['relays']> | 'skipped'
}

/** How main took the relay ids a partition write carried; nothing when it carried none. */
export function carriedRelayAnswer(
  hostId: ExecutionHostId,
  relays: DesktopRelayWrite['hosts'][number] | undefined,
  result: { status: string; relays?: CarriedRelayStatus['relays'] } | void
): CarriedRelayStatus | void {
  if (!relays) {
    return undefined
  }
  return {
    hostId,
    relays: result?.status === 'skipped' ? 'skipped' : (result?.relays ?? 'unchanged')
  }
}

/** One partition's write: only the entries main hasn't acknowledged when it supports that, else
 *  the whole fields. A failed or fenced write forgets main's copy so the next one goes whole.
 *  `relays` (entries writes only): this partition's relay ids, applied in the same write. */
export function patchHostSlice(
  api: SessionApi,
  slice: WorkspaceSessionPatch,
  hostId: ExecutionHostId,
  acknowledged: AcknowledgedWorkspaceSessionEntries | undefined,
  relays?: DesktopRelayWrite['hosts'][number]
): Promise<CarriedRelayStatus | void> {
  const target = hostId === LOCAL_EXECUTION_HOST_ID ? undefined : hostId
  if (!acknowledged || !api.patchEntries) {
    return api.patch(slice, target)
  }
  const { patch, acknowledge } = acknowledged.diff(hostId, slice)
  // Sent even when empty: main's unchanged-save handling still has to see this partition's save.
  return api.patchEntries(patch, target, relays).then(
    (result): CarriedRelayStatus | void => {
      if (result.status === 'skipped') {
        acknowledged.forget(hostId)
      } else {
        acknowledge()
      }
      if (result.normalizedFields?.length) {
        acknowledged.forget(hostId, result.normalizedFields)
      }
      if (result.normalizedEntries) {
        acknowledged.forgetEntries(hostId, result.normalizedEntries)
      }
      return carriedRelayAnswer(hostId, relays, result)
    },
    (error: unknown) => {
      acknowledged.forget(hostId)
      throw error
    }
  )
}
