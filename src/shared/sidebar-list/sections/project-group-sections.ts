import type { OccurrenceSectionPath } from '../lineage/worktree-occurrence-plan'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import { getDistinctProjectGroups } from '../../project/groups/project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import type { ExecutionHostId } from '../../execution-host/execution-host'
import { appendOrderedGroups, getProjectSectionHostIds } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './worktree-group-entry'
import { appendWorktreeRows } from './row-builders'
import { getFolderLaneSectionKey } from '../folders/folder-workspace-occurrences'
import { walkProjectGroupTree, type ProjectGroupSubtree } from './project-group-tree'
import { getFolderWorkspaceHostId } from '../hosts/folder-workspace-host-id'
import { getHostWorktreeIds } from '../hosts/host-labels'

/** Where a collapsed group's hidden rows live: per-host row counts and worktree ids. */
type CollapsedGroupHostScope = {
  hostWorktreeCounts: Map<ExecutionHostId, number>
  hostWorktreeIds: Map<ExecutionHostId, string[]>
}

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
  const { result, collapsedGroups } = ctx
  // Folder membership is already resolved above grouping; only count here (#15362).
  const folderCountByGroupId = new Map<string, number>()
  for (const pair of args.folderWorkspaces) {
    const groupId = pair.folderWorkspace.projectGroupId
    folderCountByGroupId.set(groupId, (folderCountByGroupId.get(groupId) ?? 0) + 1)
  }

  const projectGroupsById = new Map(args.projectGroups.map((group) => [group.id, group]))
  /** A collapsed group has no rows left to tell host sections which machines it belongs to. */
  const getCollapsedGroupHostScope = (
    projectGroup: ProjectGroup,
    subtree: ProjectGroupSubtree<OrderedGroupEntry[1]>
  ): CollapsedGroupHostScope | undefined => {
    const hostWorktreeCounts = new Map<ExecutionHostId, number>()
    const hostWorktreeIds = new Map<ExecutionHostId, string[]>()
    /** Counts `count` more rows on `hostId`, listing `ids` for its workspace badge. */
    const add = (hostId: ExecutionHostId, count: number, ids: readonly string[] = []): void => {
      hostWorktreeCounts.set(hostId, (hostWorktreeCounts.get(hostId) ?? 0) + count)
      hostWorktreeIds.set(hostId, [...(hostWorktreeIds.get(hostId) ?? []), ...ids])
    }
    for (const [, group] of subtree.entries) {
      const worktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
      for (const hostId of getProjectSectionHostIds(ctx, group)) {
        const ids = worktreeIds?.get(hostId) ?? []
        // Why: an empty project still places the group under its host.
        add(hostId, Math.max(1, ids.length), ids)
      }
    }
    const groupIds = new Set(subtree.groupIds)
    for (const { folderWorkspace } of args.folderWorkspaces) {
      if (groupIds.has(folderWorkspace.projectGroupId)) {
        // A nested group's folder takes its host fallback from its own group.
        const owner = projectGroupsById.get(folderWorkspace.projectGroupId) ?? projectGroup
        add(getFolderWorkspaceHostId(folderWorkspace, owner, ctx.defaultHostId), 1)
      }
    }
    return hostWorktreeCounts.size > 0 ? { hostWorktreeCounts, hostWorktreeIds } : undefined
  }
  walkProjectGroupTree(
    {
      entries: args.orderedGroups,
      projectGroups: args.projectGroups,
      folderCountByGroupId,
      projectOrderBy: args.projectOrderBy,
      repoOrder: args.repoOrder
    },
    {
      group: (projectGroup, depth, count, subtree) => {
        const key = getProjectGroupHeaderKey(projectGroup.id)
        const collapsed = collapsedGroups.has(key)
        const hostScope = collapsed
          ? getCollapsedGroupHostScope(projectGroup, subtree())
          : undefined
        result.push({
          type: 'header',
          key,
          label: projectGroup.name,
          count,
          icon: { kind: 'project' },
          projectGroup,
          projectGroupDepth: depth,
          ...hostScope
        })
        if (collapsed) {
          return false
        }
        // The group's folders, with whatever is nested under them, precede its projects.
        appendWorktreeRows(result, ctx.repoOf, ctx.occurrencePlan, {
          collapsedGroups,
          groupDepth: depth + 1,
          sectionKey: getFolderLaneSectionKey(projectGroup.id),
          hostContextLabelByWorktreeIdentity: ctx.mixedWorktreeHostContextLabels,
          folderPairByIdentity: ctx.folderPairByIdentity
        })
        return true
      },
      projects: (entries, depth) => appendOrderedGroups(ctx, entries, depth)
    }
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
