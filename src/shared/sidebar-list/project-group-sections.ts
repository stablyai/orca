import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ExecutionHostId } from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import { getDistinctProjectGroups, getEffectiveProjectGroupManualRank } from '../project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups, getProjectSectionHostIds } from './group-sections'
import { compareCodePoints, compareSidebarText } from './text-order'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './worktree-group-entry'
import {
  compareRecentRank,
  createRecentRankLookup,
  withRepoSectionDisplayLabels
} from '../project-section-order'
import { appendWorktreeRows } from './row-builders'
import { getFolderLaneSectionKey } from './folder-workspace-occurrences'
import { compareRootProjectEntries } from '../root-project-order'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'
import { getHostWorktreeIds } from './host-labels'

/** Appends every project group with its contents, then the projects outside any group. */
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
    // Use projectGroupOrder with repoOrder fallback so drag midpoint ranks match rendered order.
    return [...entries].sort((left, right) => {
      const leftRank = getEffectiveProjectGroupManualRank(left[1].repo, repoOrder)
      const rightRank = getEffectiveProjectGroupManualRank(right[1].repo, repoOrder)
      return leftRank - rightRank
    })
  }

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  // Folder membership is already resolved above grouping; only group/order here (#15362).
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

  /** Adds each host's workspaces in the group and its nested groups, at least one per project. */
  const addProjectGroupSubtreeHostScope = (
    projectGroup: ProjectGroup,
    counts: Map<ExecutionHostId, number>,
    idsByHost: Map<ExecutionHostId, string[]>
  ): void => {
    /** Counts `count` more rows on `hostId`, listing `ids` for its workspace badge. */
    const add = (hostId: ExecutionHostId, count: number, ids: readonly string[] = []): void => {
      counts.set(hostId, (counts.get(hostId) ?? 0) + count)
      idsByHost.set(hostId, [...(idsByHost.get(hostId) ?? []), ...ids])
    }
    for (const [, group] of groupByProjectGroupId.get(projectGroup.id) ?? []) {
      const worktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
      for (const hostId of getProjectSectionHostIds(ctx, group)) {
        const ids = worktreeIds?.get(hostId) ?? []
        // Why: an empty project still places the group under its host.
        add(hostId, Math.max(1, ids.length), ids)
      }
    }
    for (const { folderWorkspace } of folderWorkspacesByProjectGroupId.get(projectGroup.id) ?? []) {
      add(getFolderWorkspaceHostId(folderWorkspace, projectGroup, ctx.defaultHostId), 1)
    }
    for (const childGroup of childGroupsByParentId.get(projectGroup.id) ?? []) {
      addProjectGroupSubtreeHostScope(childGroup, counts, idsByHost)
    }
  }

  /** A collapsed group has no rows left to tell host sections which machines it belongs to. */
  const getCollapsedProjectGroupHostScope = (
    projectGroup: ProjectGroup
  ):
    | {
        hostWorktreeCounts: Map<ExecutionHostId, number>
        hostWorktreeIds: Map<ExecutionHostId, string[]>
      }
    | undefined => {
    const hostWorktreeCounts = new Map<ExecutionHostId, number>()
    const hostWorktreeIds = new Map<ExecutionHostId, string[]>()
    addProjectGroupSubtreeHostScope(projectGroup, hostWorktreeCounts, hostWorktreeIds)
    return hostWorktreeCounts.size > 0 ? { hostWorktreeCounts, hostWorktreeIds } : undefined
  }

  /** Appends a group's header and, unless collapsed, its folders, projects and nested groups. */
  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    const childGroups = childGroupsByParentId.get(projectGroup.id) ?? []
    const key = getProjectGroupHeaderKey(projectGroup.id)
    const collapsed = collapsedGroups.has(key)
    const hostScope = collapsed ? getCollapsedProjectGroupHostScope(projectGroup) : undefined
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(projectGroup.id),
      icon: { kind: 'project' },
      projectGroup,
      projectGroupDepth: depth,
      ...hostScope
    })
    if (!collapsed) {
      // The group's folders, with whatever is nested under them, precede its projects.
      appendWorktreeRows(result, ctx.repoOf, ctx.occurrencePlan, {
        collapsedGroups,
        groupDepth: depth + 1,
        sectionKey: getFolderLaneSectionKey(projectGroup.id),
        hostContextLabelByWorktreeIdentity: ctx.mixedWorktreeHostContextLabels,
        folderPairByIdentity: ctx.folderPairByIdentity
      })
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupId.delete(projectGroup.id)
  }

  const remainingRepoEntries = [...(groupByProjectGroupId.get(null) ?? [])]
  for (const [projectGroupId, entries] of groupByProjectGroupId) {
    if (projectGroupId === null || projectGroupsById.has(projectGroupId)) {
      continue
    }
    // Keep repos visible while host project-group metadata is still loading.
    remainingRepoEntries.push(...entries)
  }
  const rootEntries: ({ projectGroup: ProjectGroup } | { repoEntry: OrderedGroupEntry })[] = [
    ...(childGroupsByParentId.get(null) ?? []).map((projectGroup) => ({ projectGroup })),
    ...withRepoSectionDisplayLabels(sortRepoEntriesWithinGroup(remainingRepoEntries)).map(
      (repoEntry) => ({ repoEntry })
    )
  ]
  if (projectOrderBy === 'manual') {
    rootEntries.sort((left, right) => {
      const leftEntry =
        'projectGroup' in left
          ? { kind: 'group' as const, group: left.projectGroup }
          : left.repoEntry[1].repo
            ? { kind: 'repo' as const, repo: left.repoEntry[1].repo }
            : null
      const rightEntry =
        'projectGroup' in right
          ? { kind: 'group' as const, group: right.projectGroup }
          : right.repoEntry[1].repo
            ? { kind: 'repo' as const, repo: right.repoEntry[1].repo }
            : null
      return leftEntry && rightEntry
        ? compareRootProjectEntries(leftEntry, rightEntry, repoOrder)
        : 0
    })
  }
  for (const entry of rootEntries) {
    if ('projectGroup' in entry) {
      appendProjectGroup(entry.projectGroup, 0)
    } else {
      appendOrderedGroups(ctx, [entry.repoEntry], 0)
    }
  }
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
