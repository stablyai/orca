import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import {
  cloneDefaultWorkspaceStatuses,
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey
} from '../workspace-statuses'
import {
  ALL_GROUP_KEY,
  getNestedGroupKey,
  getPRLaneKey,
  getProjectGroupHeaderKey
} from './group-keys'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from '../project-section-grouping'
import type { ProjectSectionModel } from '../project-section-grouping'
import type { SidebarPRGroupReader, WorktreeGroupBy, WorktreeGroupBySecondary } from './row-types'

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
  /** Null reads every worktree as having no PR, which is the in-progress lane. */
  prGroupOf: SidebarPRGroupReader | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  projectGrouping?: ProjectSectionModel
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
  return getPRLaneKey(prGroupOf?.(worktree) ?? 'in-progress')
}

export function getGroupKeysForWorktree(
  groupBy: WorktreeGroupBy,
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prGroupOf: SidebarPRGroupReader | null,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  projectGroups: readonly ProjectGroup[] = [],
  projectGrouping?: ProjectSectionModel,
  groupBySecondary: WorktreeGroupBySecondary = 'none'
): string[] {
  const groupKey = getGroupKeyForWorktree(
    groupBy,
    worktree,
    repoMap,
    prGroupOf,
    workspaceStatuses,
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
    prGroupOf,
    workspaceStatuses,
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
