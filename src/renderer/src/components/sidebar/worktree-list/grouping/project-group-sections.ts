import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project-groups'
import { getProjectGroupHostId } from '../../../../store/slices/project-group-owner-routing'
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
  buildMergedProjectGroupIndex,
  findMergedProjectGroup,
  type MergedProjectGroup
} from './cross-host-project-group-merge'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { getFolderWorkspaceProjectGroupHostId } from '../../folder-workspace-host-id'

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

  // Why: a project row can carry checkouts from several hosts, so its group must be
  // the merged row rather than whichever host copy the repo id happens to name.
  const mergedIndex = buildMergedProjectGroupIndex(projectGroups)
  const mergedGroups = mergedIndex.merged
  // Why the host argument: group ids are unique per host, not globally, so two
  // hosts can reuse one id for unrelated groups.
  // Why rowId and not primary.id: two hosts reusing one group id yield two merged
  // rows with the same primary id, which would share a bucket and a header key.
  const resolveMergedRowId = (
    projectGroupId: string | null,
    hostId?: ExecutionHostId
  ): string | null =>
    projectGroupId === null
      ? null
      : (findMergedProjectGroup(mergedIndex, projectGroupId, hostId)?.rowId ?? projectGroupId)
  const getRepoHostId = (repo: Repo | undefined): ExecutionHostId =>
    repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : ctx.defaultHostId
  const groupByProjectGroupId = new Map<string | null, OrderedGroupEntry[]>()
  for (const entry of orderedGroups) {
    const repo = entry[1].repo
    const projectGroupId = resolveMergedRowId(repo?.projectGroupId ?? null, getRepoHostId(repo))
    const list = groupByProjectGroupId.get(projectGroupId) ?? []
    list.push(entry)
    groupByProjectGroupId.set(projectGroupId, list)
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
  const folderWorkspacesByProjectGroupId = new Map<string, RenderableFolderWorkspace[]>()
  for (const pair of folderWorkspaces) {
    const groupId = resolveMergedRowId(
      pair.folderWorkspace.projectGroupId,
      getFolderWorkspaceProjectGroupHostId(pair.folderWorkspace)
    )
    if (groupId === null) {
      continue
    }
    const list = folderWorkspacesByProjectGroupId.get(groupId) ?? []
    list.push(pair)
    folderWorkspacesByProjectGroupId.set(groupId, list)
  }
  for (const list of folderWorkspacesByProjectGroupId.values()) {
    list.sort((left, right) =>
      compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
    )
  }
  const childGroupsByParentId = new Map<string | null, MergedProjectGroup[]>()
  for (const merged of mergedGroups) {
    const parentId = merged.primary.parentGroupId
      ? (findMergedProjectGroup(
          mergedIndex,
          merged.primary.parentGroupId,
          getProjectGroupHostId(merged.primary)
        )?.rowId ?? null)
      : null
    const children = childGroupsByParentId.get(parentId) ?? []
    children.push(merged)
    childGroupsByParentId.set(parentId, children)
  }
  for (const groups of childGroupsByParentId.values()) {
    groups.sort(
      (left, right) =>
        left.primary.tabOrder - right.primary.tabOrder ||
        left.primary.name.localeCompare(right.primary.name)
    )
  }

  const getProjectGroupSubtreeCount = (groupId: string): number => {
    const directCount = groupByProjectGroupId.get(groupId)?.length ?? 0
    const folderWorkspaceCount = folderWorkspacesByProjectGroupId.get(groupId)?.length ?? 0
    const children = childGroupsByParentId.get(groupId) ?? []
    return children.reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child.rowId),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (merged: MergedProjectGroup, depth: number): void => {
    const projectGroup = merged.primary
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupId.get(merged.rowId) ?? [])
    const childGroups = childGroupsByParentId.get(merged.rowId) ?? []
    const key = getProjectGroupHeaderKey(merged.rowId)
    result.push({
      type: 'header',
      key,
      label: projectGroup.name,
      count: getProjectGroupSubtreeCount(merged.rowId),
      tone: PROJECT_GROUP_META.tone,
      icon: PROJECT_GROUP_META.icon,
      projectGroup,
      projectGroupDepth: depth
    })
    if (!collapsedGroups.has(key)) {
      for (const pair of folderWorkspacesByProjectGroupId.get(merged.rowId) ?? []) {
        result.push(buildFolderWorkspaceRow(pair, depth + 1))
      }
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupId.delete(merged.rowId)
  }

  for (const merged of childGroupsByParentId.get(null) ?? []) {
    appendProjectGroup(merged, 0)
  }

  const mergedRowIds = new Set(mergedGroups.map((merged) => merged.rowId))
  const remainingRepoEntries = [...(groupByProjectGroupId.get(null) ?? [])]
  for (const [projectGroupId, entries] of groupByProjectGroupId) {
    if (projectGroupId === null || mergedRowIds.has(projectGroupId)) {
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
