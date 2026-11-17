// The sidebar's project-group tree: which groups and projects show, in what order and depth.
// The desktop sidebar and the paired phone both list through this walk.
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { ProjectSectionEntry, ProjectSectionRepo } from './project-section-grouping'
import type { Repo } from '../../repository/repo-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import {
  getDistinctProjectGroups,
  getEffectiveProjectGroupManualRank
} from '../../project/groups/project-groups'
import {
  compareRecentRank,
  createRecentRankLookup,
  withRepoSectionDisplayLabels,
  type ActivityItem
} from './project-section-order'
import { compareRootProjectEntries } from './root-project-order'
import { compareCodePoints, compareSidebarText } from '../sorting/text-order'

type GroupedProjectEntry = ProjectSectionEntry<
  ActivityItem,
  ProjectSectionRepo & Partial<Pick<Repo, 'projectGroupId' | 'projectGroupOrder' | 'isPinned'>>
>

export type ProjectGroupTreeVisitor<V extends GroupedProjectEntry> = {
  /** Lists a group header; returns whether its contents follow (false when collapsed). */
  group: (group: ProjectGroup, depth: number, count: number, hasChildGroups: boolean) => boolean
  projects: (entries: [string, V][], depth: number) => void
}

export function walkProjectGroupTree<V extends GroupedProjectEntry>(
  args: {
    entries: readonly [string, V][]
    projectGroups: readonly ProjectGroup[]
    /** Folder workspaces per group; they count toward its header. */
    folderCountByGroupId: ReadonlyMap<string, number>
    projectOrderBy: ProjectOrderBy
    repoOrder: ReadonlyMap<string, number> | undefined
    isRepoEntryPinned?: (entry: [string, V]) => boolean
  },
  visit: ProjectGroupTreeVisitor<V>
): void {
  const { entries, projectGroups, folderCountByGroupId, projectOrderBy, repoOrder } = args
  const isPinnedRepoEntry =
    args.isRepoEntryPinned ?? ((entry: [string, V]) => entry[1].repo?.isPinned === true)

  const groupByProjectGroupId = new Map<string | null, [string, V][]>()
  for (const entry of entries) {
    const projectGroupId = entry[1].repo?.projectGroupId ?? null
    const list = groupByProjectGroupId.get(projectGroupId) ?? []
    list.push(entry)
    groupByProjectGroupId.set(projectGroupId, list)
  }

  const sortRepoEntriesWithinGroup = (list: [string, V][]): [string, V][] => {
    if (list.length < 2) {
      return [...list]
    }
    if (projectOrderBy === 'recent') {
      const getRecentRank = createRecentRankLookup<[string, V]>()
      return [...list].sort((left, right) => {
        const byPin = (isPinnedRepoEntry(right) ? 1 : 0) - (isPinnedRepoEntry(left) ? 1 : 0)
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
    return [...list].sort((left, right) => {
      const byPin = (isPinnedRepoEntry(right) ? 1 : 0) - (isPinnedRepoEntry(left) ? 1 : 0)
      if (byPin !== 0) {
        return byPin
      }
      const leftRank = getEffectiveProjectGroupManualRank(left[1].repo, repoOrder)
      const rightRank = getEffectiveProjectGroupManualRank(right[1].repo, repoOrder)
      return leftRank - rightRank
    })
  }

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
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
    const folderWorkspaceCount = folderCountByGroupId.get(groupId) ?? 0
    const children = childGroupsByParentId.get(groupId) ?? []
    return children.reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child.id),
      directCount + folderWorkspaceCount
    )
  }

  const walkProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const childGroups = childGroupsByParentId.get(projectGroup.id) ?? []
    const repoEntries = withRepoSectionDisplayLabels(
      sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    )
    if (
      visit.group(
        projectGroup,
        depth,
        getProjectGroupSubtreeCount(projectGroup.id),
        childGroups.length > 0
      )
    ) {
      if (childGroups.length === 0) {
        visit.projects(repoEntries, depth + 1)
      } else if (repoEntries.length === 0) {
        for (const childGroup of childGroups) {
          walkProjectGroup(childGroup, depth + 1)
        }
      } else if (projectOrderBy === 'recent') {
        for (const childGroup of childGroups) {
          if (childGroup.isPinned) {
            walkProjectGroup(childGroup, depth + 1)
          }
        }
        const pinnedRepos = repoEntries.filter(isPinnedRepoEntry)
        if (pinnedRepos.length > 0) {
          visit.projects(pinnedRepos, depth + 1)
        }
        for (const childGroup of childGroups) {
          if (!childGroup.isPinned) {
            walkProjectGroup(childGroup, depth + 1)
          }
        }
        const unpinnedRepos = repoEntries.filter((entry) => !isPinnedRepoEntry(entry))
        if (unpinnedRepos.length > 0) {
          visit.projects(unpinnedRepos, depth + 1)
        }
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
            isPinned: isPinnedRepoEntry(entry),
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
            walkProjectGroup(child.group, depth + 1)
          } else {
            visit.projects([child.entry], depth + 1)
          }
        }
      }
    }
    groupByProjectGroupId.delete(projectGroup.id)
  }

  const remainingRepoEntries = [...(groupByProjectGroupId.get(null) ?? [])]
  for (const [projectGroupId, list] of groupByProjectGroupId) {
    if (projectGroupId === null || projectGroupsById.has(projectGroupId)) {
      continue
    }
    // Keep repos visible while host project-group metadata is still loading.
    remainingRepoEntries.push(...list)
  }
  const rootEntries: ({ projectGroup: ProjectGroup } | { repoEntry: [string, V] })[] = [
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
              isPinned: isPinnedRepoEntry(entry.repoEntry)
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
    const isRootEntryPinned = (entry: (typeof rootEntries)[number]): boolean =>
      'projectGroup' in entry
        ? entry.projectGroup.isPinned === true
        : isPinnedRepoEntry(entry.repoEntry)
    rootEntries.sort(
      (left, right) => Number(isRootEntryPinned(right)) - Number(isRootEntryPinned(left))
    )
  }
  for (const entry of rootEntries) {
    if ('projectGroup' in entry) {
      walkProjectGroup(entry.projectGroup, 0)
    } else {
      visit.projects([entry.repoEntry], 0)
    }
  }
}
