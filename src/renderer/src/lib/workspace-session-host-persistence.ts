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

export type HostPersistenceState = {
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
}

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

function getFolderWorkspaceRuntimeHostId(
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
    return parsed.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
  if (workspace && group) {
    // Why: once the folder and group catalogs are both known, a missing runtime
    // owner is authoritative local/SSH persistence, not a startup gap.
    return LOCAL_EXECUTION_HOST_ID
  }
  const restoredHostId = getRestoredRuntimeHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    key
  )
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
 *  Why: only `runtime:*` worktrees are partitioned out. SSH-owned worktrees stay
 *  in the 'local' partition because the SSH flow already persists them there (in
 *  the unified blob) and separately mirrors them to each target's remote
 *  snapshot — partitioning them too would double-own that data. The one exception is an id two
 *  hosts both publish: it gets a deterministic primary so the co-claimant's rows can be parked in
 *  the shadow instead of sharing one bucket with it. */
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
      return getFolderWorkspaceRuntimeHostId(state, worktreeId)
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
    // Why: SSH-owned worktrees stay in the 'local' partition here while the runtime writes them to
    // `ssh:<targetId>`; the shared owner map records that divergence (#12723).
    return workspaceSessionPartitionHostId(repoHostId, 'local-partition')
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
  const slices = splitWorkspaceSessionByHost(payload, routing.hostIdByWorktreeId)
  attachHostSessionShadow(slices, state.contestedHostWorkspaceSessions, routing.claims, mode)
  return slices
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
    // Why: a failed runtime-partition write must not reject the local chain.
    void api.patch(slice as WorkspaceSessionPatch, hostId).catch((err) => {
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
    writes.push(api.set(slice, hostId))
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
