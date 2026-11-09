import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import {
  cloneDefaultWorkspaceStatuses,
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey
} from '../workspace-statuses'
import { ALL_GROUP_KEY, getPRLaneKey, getProjectGroupHeaderKey } from './group-keys'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from '../project-section-grouping'
import type { ProjectSectionModel } from '../project-section-grouping'
import type { SidebarPRGroupReader, WorktreeGroupBy } from './row-types'
import {
  buildUmbrellaSubfolderHierarchy,
  getUmbrellaSubfoldersGroupKey,
  normalizeRepoFilesystemPath
} from './umbrella-subfolder-groups'

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
  projectGrouping?: ProjectSectionModel
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
  if (groupBy !== 'repo') {
    return [groupKey]
  }
  const repo = repoMap.get(worktree.repoId)
  const index = buildProjectGroupingIndex(projectGrouping)
  const repoEntries = [...repoMap.values()].map((entryRepo) => ({
    key: getProjectGroupingForRepo(entryRepo.id, repoMap, index).key,
    repo: entryRepo
  }))
  const umbrellaHierarchy = buildUmbrellaSubfolderHierarchy(
    repoEntries,
    (entry) => entry.key,
    (entry) => entry.repo
  )
  const umbrellaAncestorKeys: string[] = []
  const seenUmbrella = new Set<string>()
  let currentUmbrellaKey = umbrellaHierarchy.parentKeyByKey.get(groupKey)
  while (currentUmbrellaKey && !seenUmbrella.has(currentUmbrellaKey)) {
    seenUmbrella.add(currentUmbrellaKey)
    umbrellaAncestorKeys.unshift(
      currentUmbrellaKey,
      getUmbrellaSubfoldersGroupKey(currentUmbrellaKey)
    )
    currentUmbrellaKey = umbrellaHierarchy.parentKeyByKey.get(currentUmbrellaKey)
  }

  const groupIds: string[] = []
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const visited = new Set<string>()
  let currentGroupId = repo?.projectGroupId ?? null
  while (currentGroupId && !visited.has(currentGroupId)) {
    const group = groupsById.get(currentGroupId)
    if (!group) {
      // Remote repos may precede Project Group metadata; reveal keys must match planSidebarRows’ fallback rows.
      break
    }
    visited.add(currentGroupId)
    const groupPath = normalizeRepoFilesystemPath(group.parentPath)
    const hasMatchingUmbrellaRepo =
      groupPath !== null &&
      repoEntries.some(
        (entry) =>
          entry.repo.projectGroupId === group.id &&
          normalizeRepoFilesystemPath(entry.repo.path) === groupPath
      ) &&
      repoEntries.filter((entry) => entry.repo.projectGroupId === group.id).length > 1
    if (!hasMatchingUmbrellaRepo) {
      groupIds.unshift(currentGroupId)
    }
    const parentId = group.parentGroupId ?? null
    currentGroupId = parentId && groupsById.has(parentId) ? parentId : null
  }
  return [...groupIds.map((id) => getProjectGroupHeaderKey(id)), ...umbrellaAncestorKeys, groupKey]
}
