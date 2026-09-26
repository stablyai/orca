import type { Repo } from '../../../shared/repo-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { workspaceSessionPartitionHostId } from '../../../shared/workspace-session-partition-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  attachHostSessionShadow,
  contestedPartitionHosts,
  indexWorktreeHostClaims,
  normalizeWorkspaceSessionKeyToWorktreeId,
  pickPrimaryHostForClaims,
  type HostSessionWriteMode,
  type WorktreeHostClaims
} from './workspace-session-host-contention'
import {
  nonLocalHostSessionEntries,
  splitWorkspaceSessionByHost,
  type HostSessionSlices,
  type HostIdByWorktreeId
} from './workspace-session-host-split'
import {
  indexWorkspaceRuntimeHostOwnership,
  type WorkspaceRuntimeOwnerProjection
} from './workspace-runtime-host-ownership'
import {
  buildWorktreeIdByTabId,
  extendWorktreeIdByTabId,
  type WorkspaceTabOwnerCatalog
} from '../../../shared/workspace-session-host-records'
import {
  hostHasAnsweredForTarget,
  type RemoteWorkspaceTestimonyState
} from './remote-workspace-host-testimony'
import { shadowRowsTheHostHasNotAnswered } from './workspace-session-host-shadow-testimony'

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
  /** Entries a co-claimant host lost to the primary of a contested workspace id; written straight
   *  back to their own partition so the primary's write cannot erase them. */
  contestedHostWorkspaceSessions?: HostSessionSlices
  /** Partition each restored session key was read from. Routing honours it so a write returns rows
   *  to their own partition instead of re-deriving an owner the read never agreed to. */
  contestedPrimaryHostBySessionKey?: Record<string, ExecutionHostId>
} & RemoteWorkspaceTestimonyState

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

type DurableSessionApi = SessionApi & {
  set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
  flush: () => Promise<void>
}

export type WorkspaceSessionHostSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

function getRestoredRuntimeHostId(
  owners: Record<string, ExecutionHostId> | undefined,
  key: string
): ExecutionHostId | null {
  const hostId = owners?.[key]
  return hostId && parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : null
}

function getFolderWorkspacePartitionHostId(
  state: HostPersistenceState,
  key: string
): ExecutionHostId {
  const scope = parseWorkspaceKey(key)
  if (scope?.type !== 'folder') {
    return LOCAL_EXECUTION_HOST_ID
  }
  const workspace = state.folderWorkspaces?.find((entry) => entry.id === scope.folderWorkspaceId)
  const group = workspace
    ? state.projectGroups?.find((entry) => entry.id === workspace.projectGroupId)
    : null
  const parsed = parseExecutionHostId(workspace?.executionHostId ?? group?.executionHostId)
  if (parsed) {
    // Every non-local kind owns its own partition — the same answer main's
    // RuntimeWorkspaceSessionController.getPreferredHostId gives for this key. Answering 'local'
    // for an ssh host left the renderer and the runtime writing one folder workspace into two
    // stores, which is #12723 unfixed for folder workspaces; and once the renderer began writing
    // `ssh:<targetId>` at all, a save's field-level patch erased the folder rows main had put
    // there. Boot reads these partitions from persistence's own census, not the repo catalog, so
    // a target whose only workspace is a folder is no longer unenumerated.
    return parsed.id
  }
  if (workspace && group) {
    // Why: once the folder and group catalogs are both known, a missing runtime
    // owner is authoritative local/SSH persistence, not a startup gap.
    return LOCAL_EXECUTION_HOST_ID
  }
  // Why the read source outranks the runtime-only map here: a folder workspace's partition can be
  // any kind now, and a boot that has not hydrated the folder catalog must not spill an ssh-owned
  // row into 'local' on the first save.
  const restoredHostId =
    state.contestedPrimaryHostBySessionKey?.[key] ??
    getRestoredRuntimeHostId(state.restoredRuntimeHostIdByWorkspaceSessionKey, key)
  return restoredHostId ?? LOCAL_EXECUTION_HOST_ID
}

export type HostSessionRouting = {
  hostIdByWorktreeId: HostIdByWorktreeId
  claims: WorktreeHostClaims
}

function buildRepoHostById(
  repos: HostPersistenceState['repos']
): Map<string, ExecutionHostId | null> {
  const repoHostById = new Map<string, ExecutionHostId | null>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    const existing = repoHostById.get(repo.id)
    // Why: repo ids can repeat across hosts; ambiguous repo-only ownership
    // must not let a runtime placeholder steal local session state.
    repoHostById.set(repo.id, existing === undefined ? hostId : existing === hostId ? hostId : null)
  }
  return repoHostById
}

/** Map a worktree to the host partition it persists under, plus the host claims behind it.
 *
 *  Why every non-local host and not just `runtime:*`: an SSH worktree's session is already
 *  read-modify-written into `ssh:<targetId>` by the main-process runtime, so answering 'local'
 *  here double-owned the data and left whichever half the readers skipped round-tripping as
 *  absence (#12721, #12723). The one exception is an id two hosts both publish: it gets a
 *  deterministic primary so the co-claimant's rows can be parked in the shadow instead of sharing
 *  one bucket with it. */
/** True only when the catalog positively says `hostId` no longer holds the workspace. An id the
 *  catalog cannot speak for yet keeps its restored partition — the same rule the shadow uses. */
function catalogReattributedAwayFrom(
  claims: WorktreeHostClaims,
  worktreeId: string,
  hostId: ExecutionHostId
): boolean {
  const claimed = claims.get(worktreeId)
  return Boolean(claimed) && !contestedPartitionHosts(claimed ?? []).includes(hostId)
}

export function buildHostSessionRouting(state: HostPersistenceState): HostSessionRouting {
  const repoHostById = buildRepoHostById(state.repos)
  const claims = indexWorktreeHostClaims(state.worktreesByRepo, repoHostById)
  const restoredPrimaryByWorktreeId = new Map<string, ExecutionHostId>()
  for (const [key, hostId] of Object.entries(state.contestedPrimaryHostBySessionKey ?? {})) {
    restoredPrimaryByWorktreeId.set(normalizeWorkspaceSessionKeyToWorktreeId(key), hostId)
  }
  const { repoIdByWorktreeId, runtimeHostIdByWorktreeId } = indexWorkspaceRuntimeHostOwnership(
    state.worktreesByRepo
  )

  const hostIdByWorktreeId = (worktreeId: string): ExecutionHostId => {
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      return getFolderWorkspacePartitionHostId(state, worktreeId)
    }
    const rawWorktreeId =
      workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
    const restoredPrimary =
      state.contestedPrimaryHostBySessionKey?.[worktreeId] ??
      restoredPrimaryByWorktreeId.get(rawWorktreeId)
    if (restoredPrimary && !catalogReattributedAwayFrom(claims, rawWorktreeId, restoredPrimary)) {
      // Why first: the read already decided which partition each row came from. Re-deriving an
      // owner here is what let a write copy one host's workspace into another host's partition.
      return restoredPrimary
    }
    const claimed = claims.get(rawWorktreeId)
    if (claimed && claimed.size > 1) {
      // Why partitions, not claimants: 'local' and every ssh host share one blob, so a claimant set
      // that collapses to a single partition is not separable and keeps its normal routing.
      const partitions = contestedPartitionHosts(claimed)
      if (partitions.length > 1) {
        return pickPrimaryHostForClaims(partitions)
      }
    }
    const worktreeHostId = runtimeHostIdByWorktreeId.get(rawWorktreeId)
    if (runtimeHostIdByWorktreeId.has(rawWorktreeId) && !worktreeHostId) {
      // Why: a bare worktree id whose claimants the catalog cannot name apart stays local.
      return LOCAL_EXECUTION_HOST_ID
    }
    if (worktreeHostId) {
      return worktreeHostId
    }
    const repoId = repoIdByWorktreeId.get(rawWorktreeId) ?? getRepoIdFromWorktreeId(rawWorktreeId)
    const repoHostId = repoId ? repoHostById.get(repoId) : undefined
    if (!repoHostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
    return workspaceSessionPartitionHostId(repoHostId)
  }
  return { hostIdByWorktreeId, claims }
}

export function buildHostIdByWorktreeId(state: HostPersistenceState): HostIdByWorktreeId {
  return buildHostSessionRouting(state).hostIdByWorktreeId
}

/** Partition a session for writing: route each entry to its owner host, then restore the parked
 *  rows of every host that lost a contested id so this write cannot erase them. */
function splitWorkspaceSessionForWrite(
  payload: WorkspaceSessionState,
  state: HostPersistenceState,
  mode: HostSessionWriteMode
): HostSessionSlices {
  const routing = buildHostSessionRouting(state)
  // Why the live catalogs: a debounced patch carries only the fields that changed, so a park
  // capture's layouts-only patch names no tab rows. Routed by the payload alone, every tab-keyed
  // row fell into 'local', where main pruned the scrollback it could not attribute to a remote
  // worktree — the runtime partition never received the capture (#21295).
  const worktreeIdByTabId = extendWorktreeIdByTabId(buildWorktreeIdByTabId(payload), state)
  const slices = splitWorkspaceSessionByHost(payload, routing.hostIdByWorktreeId, {
    worktreeIdByTabId
  })
  attachHostSessionShadow(
    slices,
    shadowRowsTheHostHasNotAnswered(state.contestedHostWorkspaceSessions, state),
    routing.claims,
    mode
  )
  return slices
}

const hostPartitionWriteChains = new Map<ExecutionHostId, Promise<void>>()
const hostPartitionWriteGenerations = new Map<ExecutionHostId, number>()

export function resetHostPartitionWriteStateForTest(): void {
  hostPartitionWriteChains.clear()
  hostPartitionWriteGenerations.clear()
}
function enqueueHostPartitionWrite(
  hostId: ExecutionHostId,
  state: HostPersistenceState,
  perform: () => Promise<void>
): Promise<void> {
  const parsed = parseExecutionHostId(hostId)
  const targetId = parsed?.kind === 'ssh' ? parsed.targetId : null
  const preparedWithoutTestimony = targetId !== null && !hostHasAnsweredForTarget(state, targetId)
  const nextGen = (hostPartitionWriteGenerations.get(hostId) ?? 0) + 1
  hostPartitionWriteGenerations.set(hostId, nextGen)

  const inFlight = hostPartitionWriteChains.get(hostId)
  if (!inFlight) {
    if (
      preparedWithoutTestimony &&
      targetId !== null &&
      hostHasAnsweredForTarget(state, targetId)
    ) {
      return Promise.resolve()
    }
    let resolveInFlight!: () => void
    const inFlightPromise = new Promise<void>((resolve) => {
      resolveInFlight = resolve
    })
    hostPartitionWriteChains.set(hostId, inFlightPromise)
    const result = perform()
    void result.finally(() => {
      resolveInFlight()
      if (hostPartitionWriteChains.get(hostId) === inFlightPromise) {
        hostPartitionWriteChains.delete(hostId)
      }
    })
    return result
  }

  const task = inFlight.then(async () => {
    if (
      (preparedWithoutTestimony &&
        targetId !== null &&
        hostHasAnsweredForTarget(state, targetId)) ||
      (hostPartitionWriteGenerations.get(hostId) ?? 0) > nextGen
    ) {
      return
    }
    await perform()
  })
  const tracked = task.finally(() => {
    if (hostPartitionWriteChains.get(hostId) === tracked) {
      hostPartitionWriteChains.delete(hostId)
    }
  })
  hostPartitionWriteChains.set(hostId, tracked)
  return task
}

/** Patch path of the debounced session writer: split the partial patch by owner
 *  host and patch each partition. Returns the promise for the local write so
 *  App.tsx can keep chaining the SSH remote-workspace upload off it. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionForWrite(patch as WorkspaceSessionState, state, 'patch')
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const localWrite = api.patch(local)
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    const task = enqueueHostPartitionWrite(hostId, state, () =>
      api.patch(slice as WorkspaceSessionPatch, hostId)
    )
    // Why: a failed runtime-partition write must not reject the local chain.
    void task.catch((err) => {
      console.warn(`[session] host partition patch failed for ${hostId}:`, err)
    })
  }
  return localWrite
}

/** Persist a fresh full snapshot to every owning host partition, then force the
 * main store to disk. Used by request/reply lifecycle operations whose success
 * receipt is a durability boundary rather than a debounced UI update. */
export async function persistWorkspaceSessionByHost(
  api: DurableSessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): Promise<void> {
  // Why 'replace': api.set swaps the whole partition, so parked rows must ride along even for
  // fields nothing else routed to this host.
  const slices = splitWorkspaceSessionForWrite(payload, state, 'replace')
  const writes: Promise<void>[] = [api.set(slices[LOCAL_EXECUTION_HOST_ID] ?? payload)]
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    writes.push(enqueueHostPartitionWrite(hostId, state, () => api.set(slice, hostId)))
  }
  await Promise.all(writes)
  await api.flush()
}

/** Build local-first full-session snapshots for the beforeunload / quit paths. */
export function buildWorkspaceSessionHostSnapshots(
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): WorkspaceSessionHostSnapshot[] {
  // Why 'replace': quit snapshots are applied as full partition sets.
  const slices = splitWorkspaceSessionForWrite(payload, state, 'replace')
  return [
    { state: slices[LOCAL_EXECUTION_HOST_ID] ?? payload },
    ...nonLocalHostSessionEntries(slices).map(([hostId, hostState]) => ({
      state: hostState,
      hostId
    }))
  ]
}

/** Synchronous full-session split for the beforeunload / quit paths. */
export function persistWorkspaceSessionByHostSync(
  api: SessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): void {
  for (const snapshot of buildWorkspaceSessionHostSnapshots(payload, state)) {
    api.setSync(snapshot.state, snapshot.hostId)
  }
}
