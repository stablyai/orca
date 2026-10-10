import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import {
  compareProjectGroupSiblings,
  getEffectiveProjectGroupManualRank
} from '../../../../../../shared/project-groups'
import {
  getCatalogHostId,
  getProjectGroupHostId
} from '../../../../store/slices/project-group-owner-routing'
import { PROJECT_GROUP_META, getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './project-grouping'
import {
  compareRecentRank,
  createRecentRankLookup,
  withRepoSectionDisplayLabels
} from './section-order'
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
  // Membership already decided by getRenderableFolderWorkspaces in buildRows, so
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
  // Why: ids repeat across hosts and each host nests its own copies, so a parent link resolves
  // only inside the group's catalog; linking by bare id could turn two acyclic hosts into a loop.
  const catalogGroupKey = (group: ProjectGroup, id: string): string =>
    `${getCatalogHostId(getProjectGroupHostId(group))}\u0000${id}`
  const catalogGroupKeys = new Set(projectGroups.map((group) => catalogGroupKey(group, group.id)))
  const childGroupsByParentKey = new Map<string | null, ProjectGroup[]>()
  for (const group of projectGroups) {
    const parentKey = group.parentGroupId ? catalogGroupKey(group, group.parentGroupId) : null
    const key = parentKey && catalogGroupKeys.has(parentKey) ? parentKey : null
    const children = childGroupsByParentKey.get(key) ?? []
    children.push(group)
    childGroupsByParentKey.set(key, children)
  }
  for (const groups of childGroupsByParentKey.values()) {
    groups.sort(compareProjectGroupSiblings)
  }
  const getChildGroups = (group: ProjectGroup): ProjectGroup[] =>
    childGroupsByParentKey.get(catalogGroupKey(group, group.id)) ?? []

  const getProjectGroupSubtreeCount = (group: ProjectGroup): number => {
    const directCount = groupByProjectGroupId.get(group.id)?.length ?? 0
    const folderWorkspaceCount = folderWorkspacesByProjectGroupId.get(group.id)?.length ?? 0
    return getChildGroups(group).reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    const childGroups = getChildGroups(projectGroup)
    const key = getProjectGroupHeaderKey(projectGroup.id)
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(projectGroup),
      tone: PROJECT_GROUP_META.tone,
      icon: PROJECT_GROUP_META.icon,
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

  for (const projectGroup of childGroupsByParentKey.get(null) ?? []) {
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
