import { withRepoSectionDisplayLabels } from '../project-section-order'
import { compareFolderWorkspacesForDisplay } from './folder-workspace-lanes'
import { ALL_GROUP_KEY } from './group-keys'
import { appendOrderedGroups, type SectionAppendContext } from './group-sections'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedWorktreeHostContextLabels,
  getNoticeHostContextLabels
} from './host-labels'
import { appendNestedGroups } from './nested-groups'
import { emitPinnedGroup } from './pinned-group-rows'
import { appendProjectGroupSections } from './project-group-sections'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildPendingCreationRow
} from './row-builders'
import type { Row } from './row-types'
import {
  buildSidebarRowOccurrencePlan,
  type SidebarRowPlanInputs
} from './sidebar-row-occurrence-plan'
import { getRenderedNaturalAnchorRepoIds } from './section-order'

export type { SidebarRowPlanInputs } from './sidebar-row-occurrence-plan'

/** Plans the sidebar's sections once; `render` emits rows for a collapse state. */
export function planSidebarRows(inputs: SidebarRowPlanInputs) {
  const {
    groupBy,
    groupBySecondary = 'none',
    emptySecondaryStatusSourceGroupKey = null,
    worktrees,
    repoMap,
    prGroupOf,
    repoOrder,
    workspaceStatuses,
    projectOrderBy,
    projectGroups,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingCreations,
    projectGrouping,
    hostLabelById,
    defaultHostId
  } = inputs
  const {
    occurrencePlan,
    orderedGroups,
    naturalWorktrees,
    pinnedSectionWorktrees,
    projectIndex,
    repoOf,
    renderableFolderWorkspaces,
    pendingByRepo,
    secondaryGroupBy
  } = buildSidebarRowOccurrencePlan(inputs)
  const render = (collapsedGroups: Set<string>): Row[] => {
    const result: Row[] = []
    if (groupBy !== 'repo') {
      for (const creation of pendingCreations) {
        result.push(buildPendingCreationRow(creation, repoMap))
      }
    }
    // Include pinned-only rows when testing mixed hosts or pinned remotes lose host labels.
    const mixedWorktreeHostContextLabels = getMixedWorktreeHostContextLabels(
      worktrees,
      repoOf,
      hostLabelById,
      defaultHostId
    )
    // Project ambiguity is independent of section/host filters; repoMap decides it, candidate maps gate notice eligibility.
    const noticeHostContextLabelByRepoId = getNoticeHostContextLabels(
      new Set([...importedWorktreesByRepo.keys(), ...newExternalWorktreesInboxByRepo.keys()]),
      repoMap.keys(),
      repoMap,
      projectIndex,
      hostLabelById
    )
    const renderedNaturalAnchorRepoIds = getRenderedNaturalAnchorRepoIds({
      groupBy,
      worktrees: naturalWorktrees,
      repoMap,
      prGroupOf,
      collapsedGroups,
      workspaceStatuses,
      projectGroups,
      projectGrouping,
      groupBySecondary
    })
    emitPinnedGroup(
      pinnedSectionWorktrees,
      repoOf,
      defaultHostId,
      collapsedGroups,
      renderedNaturalAnchorRepoIds,
      importedWorktreesByRepo,
      groupBy !== 'repo',
      result,
      occurrencePlan,
      noticeHostContextLabelByRepoId,
      mixedWorktreeHostContextLabels
    )
    if (groupBy === 'none') {
      // Folder-only accounts must still render flat rows (#15362).
      if (naturalWorktrees.length > 0 || renderableFolderWorkspaces.length > 0) {
        result.push({
          type: 'header',
          groupKind: 'all',
          key: ALL_GROUP_KEY,
          count: naturalWorktrees.length + renderableFolderWorkspaces.length,
          icon: { kind: 'all' },
          hostWorktreeCounts: getLaneHostWorktreeCounts(
            naturalWorktrees,
            renderableFolderWorkspaces,
            repoOf,
            defaultHostId
          ),
          hostWorktreeIds: getLaneHostWorktreeIds(
            naturalWorktrees,
            renderableFolderWorkspaces,
            repoOf,
            defaultHostId
          ),
          worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
        })
        if (!collapsedGroups.has(ALL_GROUP_KEY)) {
          appendWorktreeRows(result, repoOf, occurrencePlan, {
            collapsedGroups,
            groupDepth: 0,
            sectionKey: ALL_GROUP_KEY,
            hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels
          })
          for (const pair of [...renderableFolderWorkspaces].sort((left, right) =>
            compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
          )) {
            result.push(buildFolderWorkspaceRow(pair, 0))
          }
        }
      }
      return result
    }

    const sectionContext: SectionAppendContext = {
      result,
      groupBy,
      projectGroupingActive: groupBy === 'repo' || secondaryGroupBy === 'repo',
      collapsedGroups,
      workspaceStatuses,
      repoMap,
      repoOf,
      defaultHostId,
      hostLabelById,
      projectIndex,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo,
      pendingByRepo,
      mixedWorktreeHostContextLabels,
      noticeHostContextLabelByRepoId,
      occurrencePlan
    }

    if (secondaryGroupBy) {
      appendNestedGroups(sectionContext, orderedGroups, secondaryGroupBy, {
        repoMap,
        prGroupOf,
        repoOrder,
        projectOrderBy,
        projectGroups,
        folderWorkspaces: renderableFolderWorkspaces,
        emptySecondaryStatusSourceGroupKey
      })
      return result
    }

    if (groupBy !== 'repo' || projectGroups.length === 0) {
      appendOrderedGroups(
        sectionContext,
        groupBy === 'repo' ? withRepoSectionDisplayLabels(orderedGroups) : orderedGroups
      )
      return result
    }

    appendProjectGroupSections(sectionContext, {
      orderedGroups,
      projectGroups,
      folderWorkspaces: renderableFolderWorkspaces,
      projectOrderBy,
      repoOrder
    })

    return result
  }
  return { occurrencePlan, render }
}
