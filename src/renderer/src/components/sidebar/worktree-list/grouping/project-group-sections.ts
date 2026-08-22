import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project-groups'
import { PROJECT_GROUP_META, getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './project-grouping'
import {
  compareRecentRank,
  recentRankForEntry,
  withRepoSectionDisplayLabels
} from './section-order'
import { buildFolderWorkspaceRow } from './row-builders'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getProjectGroupHostId } from '../../../../../../shared/folder-workspace-host'

function getProjectGroupIdentity(group: ProjectGroup, defaultHostId: ExecutionHostId): string {
  return JSON.stringify([getProjectGroupHostId(group, defaultHostId), group.id])
}

export function appendProjectGroupSections(
  ctx: SectionAppendContext,
  args: {
    orderedGroups: OrderedGroupEntry[]
    projectGroups: readonly ProjectGroup[]
    folderWorkspaces: readonly RenderableFolderWorkspace[]
    projectOrderBy: ProjectOrderBy
    repoOrder: Map<string, number> | undefined
    defaultHostId: ExecutionHostId
  }
): void {
  const {
    orderedGroups,
    projectGroups,
    folderWorkspaces,
    projectOrderBy,
    repoOrder,
    defaultHostId
  } = args
  const { result, collapsedGroups } = ctx

  const projectGroupsById = new Map<string, ProjectGroup[]>()
  const projectGroupsByIdentity = new Map<string, ProjectGroup>()
  for (const group of projectGroups) {
    const sameIdGroups = projectGroupsById.get(group.id) ?? []
    sameIdGroups.push(group)
    projectGroupsById.set(group.id, sameIdGroups)
    projectGroupsByIdentity.set(getProjectGroupIdentity(group, defaultHostId), group)
  }
  const getRepoProjectGroupIdentity = (entry: OrderedGroupEntry): string | null => {
    const repo = entry[1].repo
    if (!repo?.projectGroupId) {
      return null
    }
    const matchingGroups = projectGroupsById.get(repo.projectGroupId) ?? []
    if (matchingGroups.length === 1) {
      return getProjectGroupIdentity(matchingGroups[0]!, defaultHostId)
    }
    const repoHostId =
      repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
    const hostMatches = matchingGroups.filter(
      (group) => getProjectGroupHostId(group, defaultHostId) === repoHostId
    )
    return hostMatches.length === 1 ? getProjectGroupIdentity(hostMatches[0]!, defaultHostId) : null
  }
  const groupByProjectGroupIdentity = new Map<string | null, OrderedGroupEntry[]>()
  for (const entry of orderedGroups) {
    const projectGroupIdentity = getRepoProjectGroupIdentity(entry)
    const list = groupByProjectGroupIdentity.get(projectGroupIdentity) ?? []
    list.push(entry)
    groupByProjectGroupIdentity.set(projectGroupIdentity, list)
  }

  const sortRepoEntriesWithinGroup = (entries: OrderedGroupEntry[]): OrderedGroupEntry[] => {
    if (projectOrderBy === 'recent') {
      return [...entries].sort((left, right) =>
        compareRecentRank(recentRankForEntry(left), recentRankForEntry(right))
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

  // Membership already decided by getRenderableFolderWorkspaces in buildRows, so
  // repo grouping no longer owns the filter — it only groups and orders (#15362).
  const folderWorkspacesByProjectGroupIdentity = new Map<string, RenderableFolderWorkspace[]>()
  for (const pair of folderWorkspaces) {
    const groupIdentity = getProjectGroupIdentity(pair.projectGroup, defaultHostId)
    const list = folderWorkspacesByProjectGroupIdentity.get(groupIdentity) ?? []
    list.push(pair)
    folderWorkspacesByProjectGroupIdentity.set(groupIdentity, list)
  }
  for (const list of folderWorkspacesByProjectGroupIdentity.values()) {
    list.sort((left, right) =>
      compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
    )
  }
  const childGroupsByParentIdentity = new Map<string | null, ProjectGroup[]>()
  for (const group of projectGroups) {
    const parentCandidates = group.parentGroupId
      ? (projectGroupsById.get(group.parentGroupId) ?? [])
      : []
    const groupHostId = getProjectGroupHostId(group, defaultHostId)
    const hostParents = parentCandidates.filter(
      (candidate) => getProjectGroupHostId(candidate, defaultHostId) === groupHostId
    )
    const parent =
      hostParents.length === 1
        ? hostParents[0]
        : parentCandidates.length === 1
          ? parentCandidates[0]
          : undefined
    const parentIdentity = parent ? getProjectGroupIdentity(parent, defaultHostId) : null
    const children = childGroupsByParentIdentity.get(parentIdentity) ?? []
    children.push(group)
    childGroupsByParentIdentity.set(parentIdentity, children)
  }
  for (const groups of childGroupsByParentIdentity.values()) {
    groups.sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  const getProjectGroupSubtreeCount = (groupIdentity: string): number => {
    const directCount = groupByProjectGroupIdentity.get(groupIdentity)?.length ?? 0
    const folderWorkspaceCount =
      folderWorkspacesByProjectGroupIdentity.get(groupIdentity)?.length ?? 0
    const children = childGroupsByParentIdentity.get(groupIdentity) ?? []
    return children.reduce(
      (count, child) =>
        count + getProjectGroupSubtreeCount(getProjectGroupIdentity(child, defaultHostId)),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const groupIdentity = getProjectGroupIdentity(projectGroup, defaultHostId)
    const repoEntries = sortRepoEntriesWithinGroup(
      groupByProjectGroupIdentity.get(groupIdentity) ?? []
    )
    const childGroups = childGroupsByParentIdentity.get(groupIdentity) ?? []
    const key = getProjectGroupHeaderKey(
      (projectGroupsById.get(projectGroup.id)?.length ?? 0) > 1 ? groupIdentity : projectGroup.id
    )
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(groupIdentity),
      tone: PROJECT_GROUP_META.tone,
      icon: PROJECT_GROUP_META.icon,
      projectGroup,
      projectGroupDepth: depth
    })
    if (!collapsedGroups.has(key)) {
      for (const pair of folderWorkspacesByProjectGroupIdentity.get(groupIdentity) ?? []) {
        result.push(buildFolderWorkspaceRow(pair, depth + 1))
      }
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupIdentity.delete(groupIdentity)
  }

  for (const projectGroup of childGroupsByParentIdentity.get(null) ?? []) {
    appendProjectGroup(projectGroup, 0)
  }

  const remainingRepoEntries = [...(groupByProjectGroupIdentity.get(null) ?? [])]
  for (const [projectGroupIdentity, entries] of groupByProjectGroupIdentity) {
    if (projectGroupIdentity === null || projectGroupsByIdentity.has(projectGroupIdentity)) {
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
