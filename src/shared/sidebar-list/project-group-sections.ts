import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ProjectGroup } from '../project-group-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import { getDistinctProjectGroups, getEffectiveProjectGroupManualRank } from '../project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups, type SectionAppendContext } from './group-sections'
import { compareCodePoints, compareSidebarText } from './text-order'
import type { OrderedGroupEntry } from './worktree-group-entry'
import {
  compareRecentRank,
  createRecentRankLookup,
  isProjectSectionEntryPinned,
  withRepoSectionDisplayLabels
} from '../project-section-order'
import { appendWorktreeRows } from './row-builders'
import { getFolderLaneSectionKey } from './folder-workspace-occurrences'
import { compareRootProjectEntries } from '../root-project-order'

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

  const isOrderedGroupEntryPinned = (entry: OrderedGroupEntry): boolean =>
    isProjectSectionEntryPinned(entry, ctx.repoMap, ctx.pinnedRepoIds) ||
    entry[1].items.some((worktree) => ctx.repoOf(worktree)?.isPinned === true)

  const sortRepoEntriesWithinGroup = (entries: OrderedGroupEntry[]): OrderedGroupEntry[] => {
    if (entries.length < 2) {
      return [...entries]
    }
    if (projectOrderBy === 'recent') {
      const getRecentRank = createRecentRankLookup()
      return [...entries].sort((left, right) => {
        const byPin =
          (isOrderedGroupEntryPinned(right) ? 1 : 0) - (isOrderedGroupEntryPinned(left) ? 1 : 0)
        if (byPin !== 0) {
          return byPin
        }
        return (
          compareRecentRank(getRecentRank(left), getRecentRank(right)) ||
          getEffectiveProjectGroupManualRank(left[1].repo, repoOrder) -
            getEffectiveProjectGroupManualRank(right[1].repo, repoOrder) ||
          compareSidebarText(left[1].label, right[1].label) ||
          compareCodePoints(left[0], right[0])
        )
      })
    }
    // Use projectGroupOrder with repoOrder fallback so drag midpoint ranks match rendered order.
    return [...entries].sort((left, right) => {
      const byPin =
        (isOrderedGroupEntryPinned(right) ? 1 : 0) - (isOrderedGroupEntryPinned(left) ? 1 : 0)
      if (byPin !== 0) {
        return byPin
      }
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
        (right.isPinned ? 1 : 0) - (left.isPinned ? 1 : 0) ||
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
    const repoEntries = withRepoSectionDisplayLabels(
      sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    )
    const childGroups = childGroupsByParentId.get(projectGroup.id) ?? []
    const key = getProjectGroupHeaderKey(projectGroup.id)
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(projectGroup.id),
      icon: { kind: 'project' },
      projectGroup,
      projectGroupDepth: depth,
      hasChildGroups: childGroups.length > 0
    })
    if (!collapsedGroups.has(key)) {
      // The group's folders, with whatever is nested under them, precede its projects.
      appendWorktreeRows(result, ctx.repoOf, ctx.occurrencePlan, {
        collapsedGroups,
        groupDepth: depth + 1,
        sectionKey: getFolderLaneSectionKey(projectGroup.id),
        hostContextLabelByWorktreeIdentity: ctx.mixedWorktreeHostContextLabels,
        folderPairByIdentity: ctx.folderPairByIdentity
      })
      if (childGroups.length === 0) {
        appendOrderedGroups(ctx, repoEntries, depth + 1)
      } else if (repoEntries.length === 0) {
        for (const childGroup of childGroups) {
          appendProjectGroup(childGroup, depth + 1)
        }
      } else if (projectOrderBy === 'recent') {
        for (const childGroup of childGroups) {
          if (childGroup.isPinned) {
            appendProjectGroup(childGroup, depth + 1)
          }
        }
        appendOrderedGroups(
          ctx,
          repoEntries.filter((entry) => isOrderedGroupEntryPinned(entry)),
          depth + 1
        )
        for (const childGroup of childGroups) {
          if (!childGroup.isPinned) {
            appendProjectGroup(childGroup, depth + 1)
          }
        }
        appendOrderedGroups(
          ctx,
          repoEntries.filter((entry) => !isOrderedGroupEntryPinned(entry)),
          depth + 1
        )
      } else {
        const hasExplicitRepoOrder = repoEntries.some(
          (entry) =>
            typeof entry[1].repo?.projectGroupOrder === 'number' &&
            Number.isFinite(entry[1].repo.projectGroupOrder)
        )
        const children = [
          ...childGroups.map((childGroup) => ({
            kind: 'group' as const,
            group: childGroup,
            isPinned: childGroup.isPinned === true,
            rank: childGroup.tabOrder,
            label: childGroup.name,
            id: childGroup.id
          })),
          ...repoEntries.map((entry) => ({
            kind: 'repo' as const,
            entry,
            isPinned: isOrderedGroupEntryPinned(entry),
            rank: getEffectiveProjectGroupManualRank(entry[1].repo, repoOrder),
            label: entry[1].label,
            id: entry[0]
          }))
        ].sort((left, right) => {
          const byPin = (right.isPinned ? 1 : 0) - (left.isPinned ? 1 : 0)
          if (byPin !== 0) {
            return byPin
          }
          if (!hasExplicitRepoOrder && left.kind !== right.kind) {
            return left.kind === 'repo' ? -1 : 1
          }
          if (left.rank !== right.rank) {
            return left.rank - right.rank
          }
          if (left.kind !== right.kind) {
            return left.kind === 'group' ? -1 : 1
          }
          return compareSidebarText(left.label, right.label) || compareCodePoints(left.id, right.id)
        })
        for (const child of children) {
          if (child.kind === 'group') {
            appendProjectGroup(child.group, depth + 1)
          } else {
            appendOrderedGroups(ctx, [child.entry], depth + 1)
          }
        }
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
    const toRootSortEntry = (entry: (typeof rootEntries)[number]) =>
      'projectGroup' in entry
        ? {
            kind: 'group' as const,
            group: entry.projectGroup,
            isPinned: entry.projectGroup.isPinned === true
          }
        : entry.repoEntry[1].repo
          ? {
              kind: 'repo' as const,
              repo: entry.repoEntry[1].repo,
              isPinned: isOrderedGroupEntryPinned(entry.repoEntry)
            }
          : null
    rootEntries.sort((left, right) => {
      const leftEntry = toRootSortEntry(left)
      const rightEntry = toRootSortEntry(right)
      return leftEntry && rightEntry
        ? compareRootProjectEntries(leftEntry, rightEntry, repoOrder)
        : 0
    })
  } else {
    const isRootEntryPinned = (
      entry: { projectGroup: ProjectGroup } | { repoEntry: OrderedGroupEntry }
    ): boolean =>
      'projectGroup' in entry
        ? entry.projectGroup.isPinned === true
        : isOrderedGroupEntryPinned(entry.repoEntry)
    rootEntries.sort(
      (left, right) => Number(isRootEntryPinned(right)) - Number(isRootEntryPinned(left))
    )
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
