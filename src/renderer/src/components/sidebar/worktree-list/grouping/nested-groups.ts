import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AppState } from '../../../../store/types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import { getNestedGroupKey } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { GroupChildrenAppender, SectionAppendContext } from './group-sections'
import { appendProjectGroupSections } from './project-group-sections'
import type { OrderedGroupEntry } from './project-grouping'
import type { WorktreeGroupDimension } from './row-types'
import { withRepoSectionDisplayLabels } from './section-order'
import { buildOrderedGroups } from './worktree-grouping'

/** Emits any distinct primary → secondary grouping pair with parent-qualified collapse keys. */
export function appendNestedGroups(
  ctx: SectionAppendContext,
  orderedPrimaryGroups: OrderedGroupEntry[],
  secondaryGroupBy: WorktreeGroupDimension,
  options: {
    repoMap: Map<string, Repo>
    prCache: Record<string, unknown> | null
    settings: AppState['settings'] | undefined
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
    // Discovery and creation rows have no secondary status. The primary Project
    // emitter keeps them directly below their Project header; every other pair
    // already surfaces pending rows globally before grouped rows are built.
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
      prCache: options.prCache,
      settings: options.settings,
      workspaceStatuses: ctx.workspaceStatuses,
      projectIndex: ctx.projectIndex,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingByRepo: new Map(),
      repoOrder: options.repoOrder,
      projectOrderBy: options.projectOrderBy,
      folderWorkspaces: primaryGroup.folderWorkspaces ?? [],
      // Why: rendering every empty Status under every Project would make a drag
      // explode the sidebar. Only expose the configured lanes below the source
      // parent; occupied lanes elsewhere remain visible as usual.
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
