import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import { getNestedGroupKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { GroupChildrenAppender, SectionAppendContext } from './group-sections'
import { appendProjectGroupSections } from './project-group-sections'
import { withRepoSectionDisplayLabels } from '../project-section-order'
import type { OrderedGroupEntry } from './worktree-group-entry'
import type { SidebarPRGroupReader, WorktreeGroupDimension } from './row-types'
import { buildOrderedGroups } from './worktree-grouping'

/** Emits any distinct primary → secondary grouping pair with parent-qualified collapse keys. */
export function appendNestedGroups(
  ctx: SectionAppendContext,
  orderedPrimaryGroups: OrderedGroupEntry[],
  secondaryGroupBy: WorktreeGroupDimension,
  options: {
    repoMap: Map<string, Repo>
    prGroupOf: SidebarPRGroupReader
    repoOrder: Map<string, number> | undefined
    projectOrderBy: ProjectOrderBy
    projectGroups: readonly ProjectGroup[]
    folderWorkspaces: readonly RenderableFolderWorkspace[]
    emptySecondaryStatusSourceGroupKey?: string | null
  }
): void {
  const nestedContext: SectionAppendContext = {
    ...ctx,
    groupBy: secondaryGroupBy,
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingByRepo: new Map()
  }

  const appendSecondaryChildren: GroupChildrenAppender = (
    primaryKey,
    primaryGroup,
    primaryDepth
  ) => {
    const secondaryGroups = buildOrderedGroups({
      groupBy: secondaryGroupBy,
      naturalWorktrees: primaryGroup.items,
      repoMap: options.repoMap,
      prGroupOf: options.prGroupOf,
      workspaceStatuses: ctx.workspaceStatuses,
      projectIndex: ctx.projectIndex,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingByRepo: new Map(),
      repoOrder: options.repoOrder,
      projectOrderBy: options.projectOrderBy,
      folderWorkspaces: primaryGroup.folderWorkspaces ?? [],
      includeEmptyWorkspaceStatusGroups:
        secondaryGroupBy === 'workspace-status' &&
        options.emptySecondaryStatusSourceGroupKey?.startsWith(
          `${primaryKey}/workspace-status:`
        ) === true
    })

    if (secondaryGroupBy === 'repo') {
      appendProjectGroupSections(nestedContext, {
        orderedGroups: secondaryGroups,
        projectGroups: options.projectGroups,
        folderWorkspaces: primaryGroup.folderWorkspaces ?? [],
        projectOrderBy: options.projectOrderBy,
        repoOrder: options.repoOrder,
        parentKey: primaryKey,
        baseDepth: primaryDepth + 1
      })
      return
    }

    const qualifiedSecondaryGroups: OrderedGroupEntry[] = secondaryGroups.map(
      ([secondaryKey, group]) => [
        getNestedGroupKey(primaryKey, secondaryKey),
        { ...group, sourceKey: secondaryKey }
      ]
    )
    appendOrderedGroups(nestedContext, qualifiedSecondaryGroups, primaryDepth + 1)
  }

  if (ctx.groupBy === 'repo' && options.projectGroups.length > 0) {
    appendProjectGroupSections(ctx, {
      orderedGroups: orderedPrimaryGroups,
      projectGroups: options.projectGroups,
      folderWorkspaces: options.folderWorkspaces,
      projectOrderBy: options.projectOrderBy,
      repoOrder: options.repoOrder,
      appendGroupChildren: appendSecondaryChildren
    })
    return
  }

  appendOrderedGroups(
    ctx,
    ctx.groupBy === 'repo'
      ? withRepoSectionDisplayLabels(orderedPrimaryGroups)
      : orderedPrimaryGroups,
    0,
    appendSecondaryChildren
  )
}
