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
  ProjectSectionRepo & Partial<Pick<Repo, 'projectGroupId' | 'projectGroupOrder'>>
>

export type ProjectGroupTreeVisitor<V extends GroupedProjectEntry> = {
  /** Lists a group header; returns whether its contents follow (false when collapsed). */
  group: (group: ProjectGroup, depth: number, count: number) => boolean
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
  },
  visit: ProjectGroupTreeVisitor<V>
): void {
  const { entries, projectGroups, folderCountByGroupId, projectOrderBy, repoOrder } = args

  const groupByProjectGroupId = new Map<string | null, [string, V][]>()
  for (const entry of entries) {
    const projectGroupId = entry[1].repo?.projectGroupId ?? null
    const list = groupByProjectGroupId.get(projectGroupId) ?? []
    list.push(entry)
    groupByProjectGroupId.set(projectGroupId, list)
  }

  const sortRepoEntriesWithinGroup = (list: [string, V][]): [string, V][] => {
    if (projectOrderBy === 'recent') {
      if (list.length < 2) {
        return [...list]
      }
      const getRecentRank = createRecentRankLookup<[string, V]>()
      return [...list].sort((left, right) =>
        compareRecentRank(getRecentRank(left), getRecentRank(right))
      )
    }
    // Use projectGroupOrder with repoOrder fallback so drag midpoint ranks match rendered order.
    return [...list].sort((left, right) => {
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
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(projectGroup.id) ?? [])
    if (visit.group(projectGroup, depth, getProjectGroupSubtreeCount(projectGroup.id))) {
      visit.projects(withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroupsByParentId.get(projectGroup.id) ?? []) {
        walkProjectGroup(childGroup, depth + 1)
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
      walkProjectGroup(entry.projectGroup, 0)
    } else {
      visit.projects([entry.repoEntry], 0)
    }
  }
}
