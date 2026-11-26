import type { OccurrenceSectionPath } from '../lineage/worktree-occurrence-plan'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import { getDistinctProjectGroups } from '../../project/groups/project-groups'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './worktree-group-entry'
import { appendWorktreeRows } from './row-builders'
import { getFolderLaneSectionKey } from '../folders/folder-workspace-occurrences'
import { walkProjectGroupTree } from './project-group-tree'

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
  const folderActivityByGroupId = new Map<string, number>()
  for (const pair of args.folderWorkspaces) {
    const groupId = pair.folderWorkspace.projectGroupId
    folderCountByGroupId.set(groupId, (folderCountByGroupId.get(groupId) ?? 0) + 1)
    const activity = pair.folderWorkspace.lastActivityAt
    if (activity > (folderActivityByGroupId.get(groupId) ?? Number.NEGATIVE_INFINITY)) {
      folderActivityByGroupId.set(groupId, activity)
    }
  }
  walkProjectGroupTree(
    {
      entries: args.orderedGroups,
      projectGroups: args.projectGroups,
      folderCountByGroupId,
      folderActivityByGroupId,
      projectOrderBy: args.projectOrderBy,
      repoOrder: args.repoOrder
    },
    {
      group: (projectGroup, depth, count) => {
        const key = getProjectGroupHeaderKey(projectGroup.id)
        result.push({
          type: 'header',
          key,
          label: projectGroup.name,
          count,
          icon: { kind: 'project' },
          projectGroup,
          projectGroupDepth: depth
        })
        if (collapsedGroups.has(key)) {
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
