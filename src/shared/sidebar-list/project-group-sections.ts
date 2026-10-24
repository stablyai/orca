import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ProjectGroup } from '../project-group-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import { getDistinctProjectGroups, getEffectiveProjectGroupManualRank } from '../project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import { compareCodePoints, compareSidebarText } from './text-order'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './worktree-group-entry'
import {
  compareRecentRank,
  createRecentRankLookup,
  withRepoSectionDisplayLabels
} from '../project-section-order'
import { buildFolderWorkspaceRow } from './row-builders'

export function appendProjectGroupSections(
  ctx: SectionAppendContext,
  args: {
    orderedGroups: OrderedGroupEntry[]
    projectGroups: readonly ProjectGroup[]
    folderWorkspaces: readonly RenderableFolderWorkspace[]
    projectOrderBy: ProjectOrderBy
    repoOrder: Map<string, number> | undefined
  }
): void {
  const { orderedGroups, projectGroups, folderWorkspaces, projectOrderBy, repoOrder } = args
  const { result, collapsedGroups } = ctx

  const groupByProjectGroupId = new Map<string | null, OrderedGroupEntry[]>()
  for (const entry of orderedGroups) {
    const repo = entry[1].repo
    const projectGroupId = repo?.projectGroupId ?? null
    const list = groupByProjectGroupId.get(projectGroupId) ?? []
    list.push(entry)
    groupByProjectGroupId.set(projectGroupId, list)
  }

  const sortRepoEntriesWithinGroup = (entries: OrderedGroupEntry[]): OrderedGroupEntry[] => {
    if (projectOrderBy === 'recent') {
      if (entries.length < 2) {
        return [...entries]
      }
      const getRecentRank = createRecentRankLookup()
      return [...entries].sort((left, right) =>
        compareRecentRank(getRecentRank(left), getRecentRank(right))
      )
    }
    if (projectOrderBy === 'name') {
      return [...entries].sort(
        (left, right) =>
          compareSidebarText(left[1].label, right[1].label) || compareCodePoints(left[0], right[0])
      )
    }
    // Manual: within a Project Group, projects order by their per-group rank
    // (projectGroupOrder), falling back to global repoOrder when unset so drag
    // midpoint commits and the rendered order stay aligned.
    return [...entries].sort((left, right) => {
      const leftRank = getEffectiveProjectGroupManualRank(left[1].repo, repoOrder)
      const rightRank = getEffectiveProjectGroupManualRank(right[1].repo, repoOrder)
      return leftRank - rightRank
    })
  }

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  // Membership already decided by getRenderableFolderWorkspaces in planSidebarRows, so
  // repo grouping no longer owns the filter — it only groups and orders (#15362).
  const folderWorkspacesByProjectGroupId = new Map<string, RenderableFolderWorkspace[]>()
  for (const pair of folderWorkspaces) {
    const groupId = pair.folderWorkspace.projectGroupId
    const list = folderWorkspacesByProjectGroupId.get(groupId) ?? []
    list.push(pair)
    folderWorkspacesByProjectGroupId.set(groupId, list)
  }
  for (const list of folderWorkspacesByProjectGroupId.values()) {
    list.sort((left, right) =>
      compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
    )
  }
  const childGroupsByParentId = new Map<string | null, ProjectGroup[]>()
  // Why distinct: membership is id-keyed, so a same-id copy's header would sit empty (#30045).
  for (const group of getDistinctProjectGroups(projectGroups)) {
    const parentId =
      group.parentGroupId && projectGroupsById.has(group.parentGroupId) ? group.parentGroupId : null
    const children = childGroupsByParentId.get(parentId) ?? []
    children.push(group)
    childGroupsByParentId.set(parentId, children)
  }
  for (const groups of childGroupsByParentId.values()) {
    groups.sort(
      (left, right) =>
        left.tabOrder - right.tabOrder ||
        compareSidebarText(left.name, right.name) ||
        compareCodePoints(left.executionHostId ?? '', right.executionHostId ?? '') ||
        compareCodePoints(left.id, right.id)
    )
  }

  const getProjectGroupSubtreeCount = (groupId: string): number => {
    const directCount = groupByProjectGroupId.get(groupId)?.length ?? 0
    const folderWorkspaceCount = folderWorkspacesByProjectGroupId.get(groupId)?.length ?? 0
    const children = childGroupsByParentId.get(groupId) ?? []
    return children.reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child.id),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    const childGroups = childGroupsByParentId.get(projectGroup.id) ?? []
    const key = getProjectGroupHeaderKey(projectGroup.id)
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(projectGroup.id),
      icon: { kind: 'project' },
      projectGroup,
      projectGroupDepth: depth
    })
    if (!collapsedGroups.has(key)) {
      for (const pair of folderWorkspacesByProjectGroupId.get(projectGroup.id) ?? []) {
        result.push(buildFolderWorkspaceRow(pair, depth + 1))
      }
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupId.delete(projectGroup.id)
  }

  for (const projectGroup of childGroupsByParentId.get(null) ?? []) {
    appendProjectGroup(projectGroup, 0)
  }

  const remainingRepoEntries = [...(groupByProjectGroupId.get(null) ?? [])]
  for (const [projectGroupId, entries] of groupByProjectGroupId) {
    if (projectGroupId === null || projectGroupsById.has(projectGroupId)) {
      continue
    }
    // Why: startup can have repos from hosts whose project-group metadata was
    // not fetched yet; missing metadata must not make those repos disappear.
    remainingRepoEntries.push(...entries)
  }
  appendOrderedGroups(
    ctx,
    withRepoSectionDisplayLabels(sortRepoEntriesWithinGroup(remainingRepoEntries)),
    0
  )
}

/** The same group parents used by section emission, including missing-parent roots. */
export function getProjectGroupOccurrencePaths(projectGroups: readonly ProjectGroup[]) {
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const paths = new Map<string, OccurrenceSectionPath>()
  for (const group of getDistinctProjectGroups(projectGroups)) {
    const pending: ProjectGroup[] = []
    const seen = new Set<string>()
    let current: ProjectGroup | undefined = group
    while (current && !paths.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id)
      pending.push(current)
      current = current.parentGroupId ? groupsById.get(current.parentGroupId) : undefined
    }
    let parent = current ? paths.get(current.id) : undefined
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index]
      const path: OccurrenceSectionPath = { key: getProjectGroupHeaderKey(entry.id), parent }
      paths.set(entry.id, path)
      parent = path
    }
  }
  return paths
}
