import type { OccurrenceSectionPath } from '../lineage/worktree-occurrence-plan'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import { getProjectGroupHeaderKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import type { OrderedGroupEntry } from './worktree-group-entry'
import { appendWorktreeRows } from './row-builders'
import { getFolderLaneSectionKey } from '../folders/folder-workspace-occurrences'
import { getDrawnProjectGroupParentIds, walkProjectGroupTree } from './project-group-tree'

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
  walkProjectGroupTree(
    {
      entries: args.orderedGroups,
      projectGroups: args.projectGroups,
      folderCountByGroupId,
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
  const parentIdByGroupId = getDrawnProjectGroupParentIds(projectGroups)
  const paths = new Map<string, OccurrenceSectionPath>()
  const getPath = (groupId: string): OccurrenceSectionPath => {
    const existing = paths.get(groupId)
    if (existing) {
      return existing
    }
    const parentId = parentIdByGroupId.get(groupId)
    const path: OccurrenceSectionPath = {
      key: getProjectGroupHeaderKey(groupId),
      parent: parentId ? getPath(parentId) : undefined
    }
    paths.set(groupId, path)
    return path
  }
  for (const groupId of parentIdByGroupId.keys()) {
    getPath(groupId)
  }
  return paths
}
