import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getLineageChildrenByParentId,
  getLineageChildWorktree
} from '@/components/right-sidebar/folder-workspace-attached-worktrees'
import { getCyclicProjectedWorktreeLineageIds } from '@/components/sidebar/worktree-lineage-projection'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import {
  getRepoHostSummaries,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'

function getFolderWorkspaceSubtreeIds(
  folderWorkspaceId: string,
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>,
  worktreeLineageById: Record<string, WorktreeLineage>,
  worktreeById: Map<string, Worktree>
): Set<string> {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  const rootIds = new Set<string>()
  for (const lineage of Object.values(workspaceLineageByChildKey)) {
    if (lineage.parentWorkspaceKey !== folderKey) {
      continue
    }
    // Why: the folder view drops archived and instance-stale rows, so accepting them here
    // would offer a parent whose whole branch the folder never actually shows.
    const rootWorktree = getLineageChildWorktree(lineage, worktreeById)
    if (rootWorktree) {
      rootIds.add(rootWorktree.id)
    }
  }

  const subtreeIds = new Set(rootIds)
  for (const children of getLineageChildrenByParentId(
    worktreeLineageById,
    worktreeById,
    rootIds
  ).values()) {
    for (const child of children) {
      subtreeIds.add(child.id)
    }
  }
  return subtreeIds
}

type ComposerParentState = Pick<
  AppState,
  'repos' | 'worktreesByRepo' | 'worktreeLineageById' | 'workspaceLineageByChildKey'
>
const candidateCache = new WeakMap<
  ComposerParentState['worktreesByRepo'],
  {
    state: ComposerParentState
    candidates: Map<string, Worktree[]>
  }
>()

export function getComposerLineageOwnerScope(
  hostId: ExecutionHostId
): Pick<Worktree, 'runtimeOwnerEnvironmentId'> {
  const host = parseExecutionHostId(hostId)
  return { runtimeOwnerEnvironmentId: host?.kind === 'runtime' ? host.environmentId : undefined }
}

export function getComposerParentCandidates(
  state: ComposerParentState,
  hostId: ExecutionHostId | null | undefined,
  activeFolderWorkspaceId: string | null
): Worktree[] {
  if (!hostId) {
    return []
  }
  let cache = candidateCache.get(state.worktreesByRepo)
  if (
    !cache ||
    cache.state.repos !== state.repos ||
    cache.state.worktreeLineageById !== state.worktreeLineageById ||
    cache.state.workspaceLineageByChildKey !== state.workspaceLineageByChildKey
  ) {
    cache = { state, candidates: new Map() }
    candidateCache.set(state.worktreesByRepo, cache)
  }
  const key = JSON.stringify([hostId, activeFolderWorkspaceId])
  const cached = cache.candidates.get(key)
  if (cached) {
    return cached
  }
  const owners = getRepoHostSummaries(state.repos)
  const rows = getIndexedAllWorktrees(
    state.worktreesByRepo,
    getComposerLineageOwnerScope(hostId)
  ).filter((worktree) => {
    const owner = owners.get(worktree.repoId)
    return worktreeMatchesHost(worktree, hostId, {
      unhostedWorktreesMatchHost: owner?.count === 1 && owner.onlyHostId === hostId
    })
  })
  const worktreeMap = new Map(rows.map((worktree) => [worktree.id, worktree]))
  const cyclicIds = getCyclicProjectedWorktreeLineageIds(state.worktreeLineageById, worktreeMap)
  const subtreeIds = activeFolderWorkspaceId
    ? getFolderWorkspaceSubtreeIds(
        activeFolderWorkspaceId,
        state.workspaceLineageByChildKey,
        state.worktreeLineageById,
        worktreeMap
      )
    : null
  const candidates = rows
    .filter(
      (worktree) =>
        !worktree.isArchived &&
        Boolean(worktree.instanceId) &&
        !cyclicIds.has(worktree.id) &&
        (!subtreeIds || subtreeIds.has(worktree.id))
    )
    .sort(compareWorktreeDisplayName)
  cache.candidates.set(key, candidates)
  return candidates
}
