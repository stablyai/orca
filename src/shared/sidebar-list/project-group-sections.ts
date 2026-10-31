import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId
} from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import { getDistinctProjectGroups, getEffectiveProjectGroupManualRank } from '../project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import { compareCodePoints, compareSidebarText } from './text-order'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { getProjectGroupingForRepo, type ProjectGroupingIndex } from '../project-section-grouping'
import {
  compareRecentRank,
  createRecentRankLookup,
  withRepoSectionDisplayLabels
} from '../project-section-order'
import { buildFolderWorkspaceRow } from './row-builders'

/** Every catalog row of each project section, including rows whose workspaces are pinned or absent. */
export function getProjectSectionMemberRepoIds(
  repoMap: ReadonlyMap<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): Map<string, string[]> {
  const members = new Map<string, string[]>()
  for (const repoId of repoMap.keys()) {
    const key = getProjectGroupingForRepo(repoId, repoMap, projectIndex).key
    const list = members.get(key)
    if (list) {
      list.push(repoId)
    } else {
      members.set(key, [repoId])
    }
  }
  return members
}

type CatalogEntry = Pick<ProjectGroup, 'connectionId' | 'executionHostId'>

/** The catalog that stores a row or group: local and direct-SSH entries share this Orca's own. */
function getCatalogHostId(entry: CatalogEntry): string | null {
  const host = parseRoutableExecutionHostId(getRepoExecutionHostId(entry))
  return host ? (host.kind === 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID) : null
}

/** The catalogs holding each group id; same-id copies can sit on several hosts (#30045). */
export function getProjectGroupCatalogHostIds(
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
): Map<string, Set<string>> {
  const catalogs = new Map<string, Set<string>>()
  for (const group of projectGroups) {
    const catalogHostId = getCatalogHostId(group)
    if (catalogHostId) {
      catalogs.set(group.id, (catalogs.get(group.id) ?? new Set()).add(catalogHostId))
    }
  }
  return catalogs
}

/**
 * The member row that places a section in a Project Group: a row in a group of its own host's
 * catalog, this Orca's catalog first, else the first such row in manual order. A project set up on
 * several hosts is one section whose anchor may be any host's row, so reading only the anchor drew a
 * project outside the group it was moved into, and ranking alone let another host's group override
 * this Orca's; reading visible rows only let pins and placeholders move it.
 */
export function getProjectSectionGroupRepo(
  section: Pick<WorktreeGroupEntry, 'repo'>,
  memberRepoIds: readonly string[],
  repoMap: ReadonlyMap<string, Repo>,
  repoOrder: ReadonlyMap<string, number> | undefined,
  groupCatalogHostIds: ReadonlyMap<string, ReadonlySet<string>>
): Repo | undefined {
  let grouped: Repo | undefined
  let groupedHostRank = Number.POSITIVE_INFINITY
  let groupedRank = Number.POSITIVE_INFINITY
  for (const repoId of memberRepoIds) {
    const repo = repoMap.get(repoId)
    const catalogHostId = repo ? getCatalogHostId(repo) : null
    // Why: a fetched row can carry another host's group id (applyInheritedProjectGroups);
    // only a copy of that group in the row's own catalog holds it.
    if (
      !repo?.projectGroupId ||
      !catalogHostId ||
      !groupCatalogHostIds.get(repo.projectGroupId)?.has(catalogHostId)
    ) {
      continue
    }
    const hostRank = catalogHostId === LOCAL_EXECUTION_HOST_ID ? 0 : 1
    const rank = repoOrder?.get(repoId) ?? Number.POSITIVE_INFINITY
    if (hostRank < groupedHostRank || (hostRank === groupedHostRank && rank < groupedRank)) {
      grouped = repo
      groupedHostRank = hostRank
      groupedRank = rank
    }
  }
  return grouped ?? section.repo
}

export function appendProjectGroupSections(
  ctx: SectionAppendContext,
  args: {
    orderedGroups: OrderedGroupEntry[]
    projectGroups: readonly ProjectGroup[]
    folderWorkspaces: readonly RenderableFolderWorkspace[]
    projectOrderBy: ProjectOrderBy
    repoOrder: Map<string, number> | undefined
    sectionMemberRepoIds: ReadonlyMap<string, readonly string[]>
  }
): void {
  const { orderedGroups, projectGroups, folderWorkspaces, projectOrderBy, repoOrder } = args
  const { result, collapsedGroups } = ctx

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const groupCatalogHostIds = getProjectGroupCatalogHostIds(projectGroups)
  const groupByProjectGroupId = new Map<string | null, OrderedGroupEntry[]>()
  const groupRepoByKey = new Map<string, Repo | undefined>()
  for (const entry of orderedGroups) {
    const repo = getProjectSectionGroupRepo(
      entry[1],
      args.sectionMemberRepoIds.get(entry[0]) ?? [],
      ctx.repoMap,
      repoOrder,
      groupCatalogHostIds
    )
    groupRepoByKey.set(entry[0], repo)
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
      const leftRank = getEffectiveProjectGroupManualRank(groupRepoByKey.get(left[0]), repoOrder)
      const rightRank = getEffectiveProjectGroupManualRank(groupRepoByKey.get(right[0]), repoOrder)
      return leftRank - rightRank
    })
  }

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
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1, groupRepoByKey)
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
    // Keep repos visible while host project-group metadata is still loading.
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
