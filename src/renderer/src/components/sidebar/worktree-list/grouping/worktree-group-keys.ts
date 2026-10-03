import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-status'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import type { AppState } from '../../../../store/types'
import {
  ALL_GROUP_KEY,
  getNestedGroupKey,
  getPRGroupKey,
  getProjectGroupHeaderKey
} from './group-keys'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from './project-grouping'
import type { ProjectGroupingModel } from './project-grouping'
import type { WorktreeGroupBy, WorktreeGroupBySecondary } from './row-types'

function getProjectGroupKeysForRepo(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGroups: readonly ProjectGroup[]
): string[] {
  const repo = repoMap.get(repoId)
  const groupIds: string[] = []
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const visited = new Set<string>()
  let currentGroupId = repo?.projectGroupId ?? null
  while (currentGroupId && !visited.has(currentGroupId)) {
    const group = groupsById.get(currentGroupId)
    if (!group) {
      // Why: repos can arrive before their remote Project Group metadata; reveal
      // keys must match the top-level fallback rows buildRows actually renders.
      break
    }
    visited.add(currentGroupId)
    groupIds.unshift(currentGroupId)
    const parentId = group.parentGroupId ?? null
    currentGroupId = parentId && groupsById.has(parentId) ? parentId : null
  }
  return groupIds.map((id) => getProjectGroupHeaderKey(id))
}

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
  projectGrouping?: ProjectGroupingModel,
  groupBySecondary: WorktreeGroupBySecondary = 'none'
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
  const primaryKeys =
    groupBy === 'repo'
      ? [...getProjectGroupKeysForRepo(worktree.repoId, repoMap, projectGroups), groupKey]
      : [groupKey]
  if (groupBy === 'none' || groupBySecondary === 'none' || groupBySecondary === groupBy) {
    return primaryKeys
  }

  const secondaryKey = getGroupKeyForWorktree(
    groupBySecondary,
    worktree,
    repoMap,
    prCache,
    workspaceStatuses,
    settings,
    projectGrouping
  )
  if (!secondaryKey) {
    return primaryKeys
  }
  if (groupBySecondary !== 'repo') {
    return [...primaryKeys, getNestedGroupKey(groupKey, secondaryKey)]
  }

  const nestedProjectGroupKeys = getProjectGroupKeysForRepo(
    worktree.repoId,
    repoMap,
    projectGroups
  ).map((key) => getNestedGroupKey(groupKey, key))
  return [...primaryKeys, ...nestedProjectGroupKeys, getNestedGroupKey(groupKey, secondaryKey)]
}
