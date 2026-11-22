import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { workspaceSessionPartitionHostId } from '../../../../../shared/workspace-session/workspace-session-partition-owner'
import {
  parseWorkspaceKey,
  normalizeWorkspaceSessionKeyToWorkspaceId as normalizeWorkspaceSessionKeyToWorktreeId
} from '../../../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import {
  indexWorktreeHostClaims,
  type WorktreeHostClaims
} from './workspace-session-host-contention'
import {
  contestedPartitionHosts,
  pickPrimaryHostForClaims
} from '../../../../../shared/workspace-session/workspace-session-contested-primary-host'
import type { HostIdByWorktreeId } from './workspace-session-host-split'
import { indexWorkspaceRuntimeHostOwnership } from '../ownership/workspace-runtime-host-ownership'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { HostPersistenceState } from './workspace-session-host-persistence'

type RoutingState = Pick<
  HostPersistenceState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'contestedPrimaryHostBySessionKey'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

function getRestoredRuntimeHostId(
  owners: Record<string, ExecutionHostId> | undefined,
  key: string
): ExecutionHostId | null {
  const hostId = owners?.[key]
  return hostId && parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : null
}

function getFolderWorkspacePartitionHostId(state: RoutingState, key: string): ExecutionHostId {
  const scope = parseWorkspaceKey(key)
  if (scope?.type !== 'folder') {
    return LOCAL_EXECUTION_HOST_ID
  }
  const workspace = selectFolderWorkspaces(state)?.find(
    (entry) => entry.id === scope.folderWorkspaceId
  )
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
export function buildHostSessionRouting(state: RoutingState): HostSessionRouting {
  const repoHostById = buildRepoHostById(state.repos)
  const claims = indexWorktreeHostClaims(selectWorktreesByRepo(state), repoHostById)
  const restoredPrimaryByWorktreeId = new Map<string, ExecutionHostId>()
  for (const [key, hostId] of Object.entries(state.contestedPrimaryHostBySessionKey ?? {})) {
    restoredPrimaryByWorktreeId.set(normalizeWorkspaceSessionKeyToWorktreeId(key), hostId)
  }
  const { repoIdByWorktreeId, runtimeHostIdByWorktreeId } = indexWorkspaceRuntimeHostOwnership(
    selectWorktreesByRepo(state)
  )

  const resolveHostId = (worktreeId: string): ExecutionHostId => {
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
  // Routing reads only the captured state, and many tab and pane keys share a workspace: resolve each once.
  const hostByWorktreeId = new Map<string, ExecutionHostId>()
  const hostIdByWorktreeId = (worktreeId: string): ExecutionHostId => {
    let hostId = hostByWorktreeId.get(worktreeId)
    if (hostId === undefined) {
      hostId = resolveHostId(worktreeId)
      hostByWorktreeId.set(worktreeId, hostId)
    }
    return hostId
  }
  return { hostIdByWorktreeId, claims }
}

/** Routing reads only these (the last two shape which partitions a write reaches): while they keep
 *  their identities, so does the routing. */
export const SESSION_ROUTING_FIELDS = [
  'repos',
  'worktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'contestedPrimaryHostBySessionKey',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'hydratedRuntimeSessionHostIds',
  'contestedHostWorkspaceSessions'
] as const satisfies readonly (keyof HostPersistenceState)[]

function sessionRoutingInputs(state: HostPersistenceState): readonly unknown[] {
  return SESSION_ROUTING_FIELDS.map((field) => state[field])
}

let cachedRouting: { inputs: readonly unknown[]; routing: HostSessionRouting } | null = null

/** One routing per input identities: its identity is the routing generation keyed writes check. */
export function sessionRoutingFor(state: HostPersistenceState): HostSessionRouting {
  const inputs = sessionRoutingInputs(state)
  if (!cachedRouting || inputs.some((input, index) => input !== cachedRouting?.inputs[index])) {
    // Only routing's own inputs: the cache must not keep a whole store snapshot alive.
    const { repos, worktreesByRepo, folderWorkspaces, projectGroups } = state
    const routing = buildHostSessionRouting({
      repos,
      worktreesByRepo,
      folderWorkspaces,
      projectGroups,
      contestedPrimaryHostBySessionKey: state.contestedPrimaryHostBySessionKey,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    })
    cachedRouting = { inputs, routing }
  }
  return cachedRouting.routing
}

export function buildHostIdByWorktreeId(state: RoutingState): HostIdByWorktreeId {
  return buildHostSessionRouting(state).hostIdByWorktreeId
}
