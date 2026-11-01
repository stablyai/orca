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
  indexWorktreeHostClaims,
  normalizeWorkspaceSessionKeyToWorktreeId,
  type HostSessionWriteMode,
  type WorktreeHostClaims
} from './workspace-session-host-contention'
import {
  contestedPartitionHosts,
  pickPrimaryHostForClaims
} from '../../../shared/workspace-session-contested-primary-host'
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

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
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
    // Why: every non-local kind owns its own partition, matching main's getPreferredHostId (#12723).
    return parsed.id
  }
  if (workspace && group) {
    // Once folder/group catalogs hydrate, absent runtime ownership means authoritative local/SSH, not a startup gap.
    return LOCAL_EXECUTION_HOST_ID
  }
  // Read source outranks runtime-only maps: SSH folder rows must not spill local before catalog hydration.
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
    // Repo IDs can collide across hosts; ambiguous repo-only owners must not let runtime placeholders take local sessions.
    repoHostById.set(repo.id, existing === undefined ? hostId : existing === hostId ? hostId : null)
  }
  return repoHostById
}

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

/** Route all nonlocal hosts to their own partitions, matching main; local-only SSH writes created split ownership/read-as-absence (#12721/#12723). Contested IDs retain one primary plus parked co-claimants. */
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
      // Honor the read source first; recomputing can move rows between hosts’ partitions.
      return restoredPrimary
    }
    const claimed = claims.get(rawWorktreeId)
    if (claimed && claimed.size > 1) {
      // Use separable storage partitions, not claimant count: collapsed claimants sharing local/SSH blob keep normal routing.
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

/** Split patches by owner. localWrite orders SSH upload; written waits for all partitions and rejects failures so callers requeue fields. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState
): { localWrite: Promise<void>; written: Promise<void> } {
  const slices = splitWorkspaceSessionForWrite(patch as WorkspaceSessionState, state, 'patch')
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const localWrite = api.patch(local)
  const hostWrites = nonLocalHostSessionEntries(slices).map(([hostId, slice]) =>
    api.patch(slice, hostId).catch((err: unknown) => {
      console.warn(`[session] host partition patch failed for ${hostId}:`, err)
      throw err
    })
  )
  // Why allSettled: every partition finishes before a retry rewrites the same fields.
  const written = Promise.allSettled([localWrite, ...hostWrites]).then((results) => {
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  })
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
  await Promise.all(
    buildWorkspaceSessionHostSnapshots(payload, state).map((s) => api.set(s.state, s.hostId))
  )
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
