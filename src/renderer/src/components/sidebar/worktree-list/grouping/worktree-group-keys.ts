import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-status'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import type { AppState } from '../../../../store/types'
import { ALL_GROUP_KEY, getPRGroupKey, getProjectGroupHeaderKey } from './group-keys'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from './project-grouping'
import {
  buildMergedProjectGroupIndex,
  buildProjectGroupHostIndex,
  findProjectGroupByHost,
  resolveMergedProjectGroupId
} from './cross-host-project-group-merge'
import type { ProjectGroupingModel } from './project-grouping'
import type { WorktreeGroupBy } from './row-types'

export function getGroupKeyForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  settings?: AppState['settings'],
  projectGrouping?: ProjectGroupingModel
): string | null {
  if (groupBy === 'none') {
    return ALL_GROUP_KEY
  }
  if (groupBy === 'workspace-status') {
    return getWorkspaceStatusGroupKey(getWorkspaceStatus(worktree, workspaceStatuses))
  }
  if (groupBy === 'repo') {
    return getProjectGroupingForRepo(
      worktree.repoId,
      repoMap,
      buildProjectGroupingIndex(projectGrouping)
    ).key
  }
  return `pr:${getPRGroupKey(worktree, repoMap, prCache, settings)}`
}

export function getGroupKeysForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  settings?: AppState['settings'],
  projectGroups: readonly ProjectGroup[] = [],
  projectGrouping?: ProjectGroupingModel
): string[] {
  const groupKey = getGroupKeyForWorktree(
    groupBy,
    worktree,
    repoMap,
    prCache,
    workspaceStatuses,
    settings,
    projectGrouping
  )
  if (!groupKey) {
    return []
  }
  if (groupBy !== 'repo') {
    return [groupKey]
  }
  const repo = repoMap.get(worktree.repoId)
  const groupIds: string[] = []
  // Why: the sidebar renders one header per merged group, so a key built from a
  // non-primary host copy's id would never match the row it means to reveal.
  const mergedIndex = buildMergedProjectGroupIndex(projectGroups)
  const repoHostId =
    repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : undefined
  // Why host-scoped: parentGroupId names a group on the repo's own host, and a bare
  // id can land on another host's unrelated group before merged-id resolution runs.
  const groupHostIndex = buildProjectGroupHostIndex(projectGroups)
  const visited = new Set<string>()
  let currentGroupId = repo?.projectGroupId ?? null
  while (currentGroupId && !visited.has(currentGroupId)) {
    const group = findProjectGroupByHost(groupHostIndex, currentGroupId, repoHostId)
    if (!group) {
      // Why: repos can arrive before their remote Project Group metadata; reveal
      // keys must match the top-level fallback rows buildRows actually renders.
      break
    }
    visited.add(currentGroupId)
    groupIds.unshift(currentGroupId)
    const parentId = group.parentGroupId ?? null
    currentGroupId =
      parentId && findProjectGroupByHost(groupHostIndex, parentId, repoHostId) ? parentId : null
  }
  return [
    ...groupIds.map((id) =>
      getProjectGroupHeaderKey(resolveMergedProjectGroupId(mergedIndex, id, repoHostId))
    ),
    groupKey
  ]
}
