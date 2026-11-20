import type { Repo } from '../../../../../shared/repository/repo-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  attachHostSessionShadow,
  type HostSessionWriteMode
} from './workspace-session-host-contention'
import {
  nonLocalHostSessionEntries,
  splitWorkspaceSessionByHost,
  type HostSessionSlices
} from './workspace-session-host-split'
import type { WorkspaceRuntimeOwnerProjection } from '../ownership/workspace-runtime-host-ownership'
import {
  buildWorktreeIdByTabId,
  extendWorktreeIdByTabId,
  type WorkspaceTabOwnerCatalog
} from '../../../../../shared/workspace-session/workspace-session-host-records'
import type {
  WorkspaceSessionEntriesPatch,
  WorkspaceSessionEntriesPatchResult
} from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import {
  windowAcknowledgedSessionEntries,
  type AcknowledgedWorkspaceSessionEntries
} from './workspace-session-acknowledged-entries'
import { patchHostSlice, routedSessionHostIds } from './workspace-session-host-entries-write'
import type { SessionRelevantField } from './workspace-session'
import {
  afterDesktopRelayProbe,
  probeDesktopRelays,
  desktopRelayWriteFor,
  replaceDesktopRelays,
  type DesktopRelayApi
} from './desktop-relay-writes'
import {
  planDesktopRelayWrite,
  slicedHostIds,
  setSnapshotsWithRelays,
  settleSessionWrites,
  type SessionWriteOutcome,
  type SnapshotSetApi
} from './desktop-relay-write-plan'
import type { DesktopRelayWrite } from '../../../../../shared/workspace-session/desktop-relay-write'
import { sessionRoutingFor } from './workspace-session-host-routing'

export type HostPersistenceState = WorkspaceTabOwnerCatalog & {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  projectGroups?: readonly { id: string; executionHostId?: string | null }[]
  folderWorkspaces?: readonly {
    id: string
    projectGroupId: string
    executionHostId?: ExecutionHostId | null
  }[]
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  hydratedRuntimeSessionHostIds?: readonly ExecutionHostId[]
  /** Entries a co-claimant host lost to the primary of a contested workspace id; written straight
   *  back to their own partition so the primary's write cannot erase them. */
  contestedHostWorkspaceSessions?: HostSessionSlices
  /** Partition each restored session key was read from. Routing honours it so a write returns rows
   *  to their own partition instead of re-deriving an owner the read never agreed to. */
  contestedPrimaryHostBySessionKey?: Record<string, ExecutionHostId>
}

export type SessionApi = DesktopRelayApi & {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  /** Absent on clients whose session store takes whole fields only (the paired web client). */
  patchEntries?: (
    args: WorkspaceSessionEntriesPatch,
    hostId?: ExecutionHostId,
    relays?: DesktopRelayWrite['hosts'][number]
  ) => Promise<WorkspaceSessionEntriesPatchResult>
}

type DurableSessionApi = SessionApi & SnapshotSetApi & { flush: () => Promise<void> }

export type WorkspaceSessionHostSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

/** Partition a session for writing: route each entry to its owner host, then restore the parked
 *  rows of every host that lost a contested id so this write cannot erase them. */
function splitWorkspaceSessionForWrite(
  payload: WorkspaceSessionState,
  state: HostPersistenceState,
  mode: HostSessionWriteMode,
  routing = sessionRoutingFor(state)
): HostSessionSlices {
  const catalogRuntimeHostIds = new Set(state.repos.map((repo) => getRepoExecutionHostId(repo)))
  // A patch replaces fields fieldwise, so a host whose last entry went needs the emptied field. Only a
  // partition this window loaded and still catalogs is one its state speaks for in full.
  // The contested shadow restores only worktree-keyed rows, so a host holding parked rows keeps today's rule.
  const emptyContainerHostIds =
    mode === 'patch'
      ? (state.hydratedRuntimeSessionHostIds ?? []).filter(
          (hostId) =>
            catalogRuntimeHostIds.has(hostId) && !state.contestedHostWorkspaceSessions?.[hostId]
        )
      : []
  // Use live tab catalogs for layouts-only patches; payload-only routing loses remote park scrollback in local pruning (#21295).
  const worktreeIdByTabId = extendWorktreeIdByTabId(buildWorktreeIdByTabId(payload), state)
  const slices = splitWorkspaceSessionByHost(payload, routing.hostIdByWorktreeId, {
    worktreeIdByTabId,
    emptyContainerHostIds
  })
  attachHostSessionShadow(slices, state.contestedHostWorkspaceSessions, routing.claims, mode)
  return slices
}

/** Split patches by owner. localWrite orders SSH upload; written waits for all partitions and rejects failures so callers requeue fields.
 *  `inputs`: the changed store fields this patch was built from; once every host accepts it, a later
 *  keyed write of those fields may send only its keys. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState,
  acknowledged?: AcknowledgedWorkspaceSessionEntries,
  inputs: readonly SessionRelevantField[] = []
): { localWrite: Promise<void>; written: Promise<SessionWriteOutcome | void> } {
  const retry = () => patchWorkspaceSessionByHost(api, patch, state, acknowledged, inputs)
  const afterProbe = afterDesktopRelayProbe(api, patch, retry)
  if (afterProbe) {
    return afterProbe
  }
  const routing = sessionRoutingFor(state)
  const slices = splitWorkspaceSessionForWrite(
    patch as WorkspaceSessionState,
    state,
    'patch',
    routing
  )
  // Only entries writes use the host set: relay ids ride with them, and they settle inputs.
  const hostIds = acknowledged && api.patchEntries ? slicedHostIds(slices) : null
  const relays = desktopRelayWriteFor(api, patch, slices, state)
  acknowledged?.retainHosts(routedSessionHostIds(state, slices))
  // After dropping unrouted hosts: that forget must not cancel this write's own settling.
  const settleMark = acknowledged?.settleMark()
  const outputs = Object.keys(patch)
  if (hostIds) {
    acknowledged?.supersede(outputs, hostIds)
  }
  // A host's relay ids ride with its entries patch, so main publishes them together once.
  const relayPlan = relays && planDesktopRelayWrite(api, relays, hostIds ?? new Set())
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const carriedLocal = relayPlan?.carried.get(LOCAL_EXECUTION_HOST_ID)
  const localSlice = patchHostSlice(api, local, LOCAL_EXECUTION_HOST_ID, acknowledged, carriedLocal)
  const localWrite = localSlice.then(() => {})
  const hostWrites = nonLocalHostSessionEntries(slices).map(([hostId, slice]) =>
    patchHostSlice(api, slice, hostId, acknowledged, relayPlan?.carried.get(hostId)).catch(
      (err: unknown) => {
        console.warn(`[session] host partition patch failed for ${hostId}:`, err)
        throw err
      }
    )
  )
  // After the partition patches, so main applies relay ids to the rows they just wrote.
  const separate = relayPlan?.sendRest()
  const written = settleSessionWrites([localSlice, ...hostWrites, separate], relayPlan)
  if (acknowledged && hostIds && settleMark !== undefined) {
    written.then(
      (outcome) => {
        if (outcome?.pendingFields?.length) {
          acknowledged.unsettle()
        } else {
          acknowledged.settle(settleMark, routing, inputs, outputs, hostIds)
        }
      },
      () => acknowledged.unsettle()
    )
  }
  // Why: a host failure must not surface as an unhandled rejection on the upload chain's promise.
  localWrite.catch(() => {})
  return { localWrite, written }
}

/** Write full snapshots to each owner and force main to disk; request/reply lifecycle receipts represent durability, unlike debounced UI updates. */
export async function persistWorkspaceSessionByHost(
  api: DurableSessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): Promise<void> {
  const separate = await probeDesktopRelays(api)
  const { snapshots, desktopRelays } = buildWorkspaceSessionHostSnapshots(payload, state, separate)
  await setSnapshotsWithRelays(api, snapshots, desktopRelays)
  await api.flush()
}

/** Build local-first full-session snapshots for the beforeunload / quit paths. With
 *  `relaysSeparate`, the relay ids leave them for one write main applies by ownership. */
export function buildWorkspaceSessionHostSnapshots(
  payload: WorkspaceSessionState,
  state: HostPersistenceState,
  relaysSeparate = false
): { snapshots: WorkspaceSessionHostSnapshot[]; desktopRelays: DesktopRelayWrite | null } {
  // Why 'replace': quit snapshots are applied as full partition sets.
  const slices = splitWorkspaceSessionForWrite(payload, state, 'replace')
  const desktopRelays = relaysSeparate ? replaceDesktopRelays(slices, state) : null
  // They replace main's copy, including when the unload is vetoed and the window stays.
  windowAcknowledgedSessionEntries.forget()
  return {
    desktopRelays,
    snapshots: [
      { state: slices[LOCAL_EXECUTION_HOST_ID] ?? payload },
      ...nonLocalHostSessionEntries(slices).map(([hostId, hostState]) => ({
        state: hostState,
        hostId
      }))
    ]
  }
}
