import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import {
  buildProjectGroupOwnerIndex,
  getEffectiveProjectGroupManualRank,
  getProjectGroupIdentity,
  getProjectGroupOwnerHostId,
  getProjectGroupOwnerIdentity
} from '../../../../../../shared/project-groups'
import { resolveFolderWorkspaceProjectGroupWithLegacySsh } from '../../../../../../shared/folder-workspaces'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { PROJECT_GROUP_META, getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './project-grouping'
import {
  compareRecentRank,
  recentRankForEntry,
  withRepoSectionDisplayLabels
} from './section-order'

export function appendProjectGroupSections(
  ctx: SectionAppendContext,
  args: {
    orderedGroups: OrderedGroupEntry[]
    projectGroups: readonly ProjectGroup[]
    folderWorkspaces: readonly FolderWorkspace[]
    projectOrderBy: ProjectOrderBy
    repoOrder: Map<string, number> | undefined
  }
): void {
  const { orderedGroups, projectGroups, folderWorkspaces, projectOrderBy, repoOrder } = args
  const { result, collapsedGroups } = ctx

  const projectGroupIndex = buildProjectGroupOwnerIndex(projectGroups)
  const duplicateFolderWorkspaceIds = new Set(
    folderWorkspaces
      .map((workspace) => workspace.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index)
  )
  const groupByProjectGroupIdentity = new Map<string | null, OrderedGroupEntry[]>()
  for (const entry of orderedGroups) {
    const repo = entry[1].repo
    const projectGroupIdentity = repo?.projectGroupId
      ? getProjectGroupIdentity(repo.projectGroupId, getRepoExecutionHostId(repo))
      : null
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

  const folderWorkspacesByProjectGroupIdentity = new Map<string, FolderWorkspace[]>()
  for (const workspace of folderWorkspaces) {
    const group = resolveFolderWorkspaceProjectGroupWithLegacySsh(projectGroupIndex, workspace)
    if (!group?.parentPath) {
      continue
    }
    const identity = getProjectGroupOwnerIdentity(group)
    const list = folderWorkspacesByProjectGroupIdentity.get(identity) ?? []
    list.push(workspace)
    folderWorkspacesByProjectGroupIdentity.set(identity, list)
  }
  for (const list of folderWorkspacesByProjectGroupIdentity.values()) {
    list.sort((left, right) => {
      const leftOrder = left.manualOrder ?? left.sortOrder
      const rightOrder = right.manualOrder ?? right.sortOrder
      return rightOrder - leftOrder || left.name.localeCompare(right.name)
    })
  }
  const childGroupsByParentIdentity = new Map<string | null, ProjectGroup[]>()
  for (const group of projectGroups) {
    const parentIdentity = group.parentGroupId
      ? getProjectGroupIdentity(group.parentGroupId, getProjectGroupOwnerHostId(group))
      : null
    const resolvedParentIdentity =
      parentIdentity && projectGroupIndex.byIdentity.has(parentIdentity) ? parentIdentity : null
    const children = childGroupsByParentIdentity.get(resolvedParentIdentity) ?? []
    children.push(group)
    childGroupsByParentIdentity.set(resolvedParentIdentity, children)
  }
  for (const groups of childGroupsByParentIdentity.values()) {
    groups.sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  const getProjectGroupSubtreeCount = (group: ProjectGroup): number => {
    const identity = getProjectGroupOwnerIdentity(group)
    const directCount = groupByProjectGroupIdentity.get(identity)?.length ?? 0
    const folderWorkspaceCount = folderWorkspacesByProjectGroupIdentity.get(identity)?.length ?? 0
    const children = childGroupsByParentIdentity.get(identity) ?? []
    return children.reduce(
      (count, child) => count + getProjectGroupSubtreeCount(child),
      directCount + folderWorkspaceCount
    )
  }

  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const identity = getProjectGroupOwnerIdentity(projectGroup)
    const repoEntries = sortRepoEntriesWithinGroup(groupByProjectGroupIdentity.get(identity) ?? [])
    const childGroups = childGroupsByParentIdentity.get(identity) ?? []
    const key = getProjectGroupHeaderKey(
      projectGroup.id,
      (projectGroupIndex.byId.get(projectGroup.id)?.length ?? 0) > 1
        ? getProjectGroupOwnerHostId(projectGroup)
        : undefined
    )
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
      for (const folderWorkspace of folderWorkspacesByProjectGroupIdentity.get(identity) ?? []) {
        result.push({
          type: 'folder-workspace',
          key: `${key}:folder-workspace:${folderWorkspace.id}`,
          folderWorkspace,
          projectGroup,
          workspaceKey: folderWorkspaceKey(
            folderWorkspace.id,
            duplicateFolderWorkspaceIds.has(folderWorkspace.id)
              ? getProjectGroupOwnerHostId(projectGroup)
              : undefined
          ),
          depth: 0,
          groupDepth: depth + 1
        })
      }
      appendOrderedGroups(ctx, withRepoSectionDisplayLabels(repoEntries), depth + 1)
      for (const childGroup of childGroups) {
        appendProjectGroup(childGroup, depth + 1)
      }
    }
    groupByProjectGroupIdentity.delete(identity)
  }

  for (const projectGroup of childGroupsByParentIdentity.get(null) ?? []) {
    appendProjectGroup(projectGroup, 0)
  }

  const remainingRepoEntries = [...(groupByProjectGroupIdentity.get(null) ?? [])]
  for (const [projectGroupIdentity, entries] of groupByProjectGroupIdentity) {
    if (projectGroupIdentity === null || projectGroupIndex.byIdentity.has(projectGroupIdentity)) {
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
