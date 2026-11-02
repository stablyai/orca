import type { FolderWorkspace } from '../folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedWorktreeHostContextLabels,
  getNoticeHostContextLabels
} from './host-labels'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from '../project-section-grouping'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrenceSection
} from '../worktree-occurrence-plan'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import type { ProjectSectionModel } from '../project-section-grouping'
import {
  appendProjectGroupSections,
  getProjectGroupOccurrencePaths
} from './project-group-sections'
import { getSidebarLineageChildren } from './pinned-section-worktrees'
import { emitPinnedGroup } from './pinned-group-rows'
import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildPendingCreationRow
} from './row-builders'
import {
  compareFolderWorkspacesForDisplay,
  getRenderableFolderWorkspaces
} from './folder-workspace-lanes'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  RepoOfWorktree,
  Row,
  SidebarPRGroupReader,
  WorktreeGroupBy
} from './row-types'
import { orderMainWorktreeFirst, getRenderedNaturalAnchorRepoIds } from './section-order'
import { withRepoSectionDisplayLabels } from '../project-section-order'
import { buildOrderedGroups } from './worktree-grouping'

type SidebarOccurrenceSection = WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry }

/** Everything the row builder reads. Pure data: no store, clock or client-specific state. */
export type SidebarRowPlanInputs = {
  groupBy: WorktreeGroupBy
  /** Visible worktrees in the frozen sort order. */
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
  /** Defaults to repoMap's registration for the row's repo id. */
  repoOfWorktree?: RepoOfWorktree
  prGroupOf: SidebarPRGroupReader
  repoOrder?: Map<string, number>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectOrderBy: ProjectOrderBy
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  projectGroups: readonly ProjectGroup[]
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingCreations: readonly PendingCreationRef[]
  projectGrouping?: ProjectSectionModel
  folderWorkspaces: readonly FolderWorkspace[]
  hostLabelById?: ReadonlyMap<string, string>
  defaultHostId: ExecutionHostId
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  filterRepoIds: readonly string[]
}

/** Plans the sidebar's sections once; `render` emits rows for a collapse state. */
export function planSidebarRows(inputs: SidebarRowPlanInputs) {
  const {
    groupBy,
    worktrees,
    repoMap,
    repoOfWorktree,
    prGroupOf,
    repoOrder,
    workspaceStatuses,
    projectOrderBy,
    lineageById,
    worktreeMap,
    nestLineage,
    projectGroups,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingCreations,
    projectGrouping,
    folderWorkspaces,
    hostLabelById,
    defaultHostId,
    pinnedDisplayPolicy,
    filterRepoIds
  } = inputs
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  const repoOf = repoOfWorktree ?? ((worktree: Worktree) => repoMap.get(worktree.repoId))
  // Resolve folder membership before groupBy; every mode renders the same set (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: nestLineage
      ? getSidebarLineageChildren(worktrees, lineageById, worktreeMap, filterRepoIds)
      : new Map<string, Worktree[]>(),
    isPinned: (worktree) => worktree.isPinned === true,
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionOf: (worktree) =>
      getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex, repoOf(worktree)),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) => {
      const groups: OrderedGroupEntry[] =
        groupBy === 'none'
          ? [[ALL_GROUP_KEY, { label: '', items: [...natural], repoIds: new Set() }]]
          : buildOrderedGroups({
              groupBy,
              naturalWorktrees: natural,
              repoOfWorktree: repoOf,
              repoMap,
              prGroupOf,
              workspaceStatuses,
              projectIndex,
              displayRootByIdentity,
              placeholderRepoIds,
              importedWorktreesByRepo,
              newExternalWorktreesInboxByRepo,
              pendingByRepo,
              repoOrder,
              projectOrderBy,
              folderWorkspaces: renderableFolderWorkspaces
            })
      if (pinned.length > 0) {
        groups.unshift([PINNED_GROUP_KEY, { label: '', items: pinned, repoIds: new Set() }])
      }
      return groups.map(([key, group]): SidebarOccurrenceSection => {
        const revealPath =
          groupBy === 'repo' && key !== PINNED_GROUP_KEY && group.repo?.projectGroupId
            ? projectGroupPaths.get(group.repo.projectGroupId)
            : undefined
        return {
          key,
          group,
          placement: key === PINNED_GROUP_KEY ? 'pinned' : 'natural',
          items:
            groupBy === 'repo' && key !== PINNED_GROUP_KEY
              ? orderMainWorktreeFirst(group.items)
              : group.items,
          revealPath: { key, parent: revealPath }
        }
      })
    }
  })
  const pinnedSectionWorktrees =
    occurrencePlan.sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = occurrencePlan.sections
    .filter((section) => section.key !== PINNED_GROUP_KEY)
    .map((section) => [section.key, section.group])
  const naturalWorktrees = orderedGroups.flatMap(([, group]) => group.items)
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
      projectGrouping
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
