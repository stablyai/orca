import { buildWorkspaceStatusLookup } from '../workspace-statuses'
import { groupPendingCreationsByRepo } from './pending-creation-repos'
import { getWorktreeExecutionHostId } from '../execution-host'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { SidebarLineageParentIdentities } from './worktree-lineage-projection'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import { getMixedWorktreeHostContextLabels, getNoticeHostContextLabels } from './host-labels'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  getProjectSectionRepoLookup,
  type ProjectSectionModel
} from '../project-section-grouping'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrenceSection
} from '../worktree-occurrence-plan'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'

import {
  appendProjectGroupSections,
  getProjectGroupOccurrencePaths
} from './project-group-sections'
import { getSidebarLineageChildren } from './pinned-section-worktrees'
import { emitPinnedGroup } from './pinned-group-rows'
import { appendUngroupedWorkspaceRows, buildPendingCreationRow } from './row-builders'
import { getRenderableFolderWorkspaces } from './folder-workspace-lanes'
import { getFolderLaneSections, getSidebarFolderOccurrences } from './folder-workspace-occurrences'
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
import { orderMainWorktreeFirst, getOrderedOccurrenceGroups } from './section-order'
import { appendImportedWorktreeLines } from './imported-worktree-lines'
import { withRepoSectionDisplayLabels } from '../project-section-order'
import { buildOrderedGroups } from './worktree-grouping'
import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

type SidebarOccurrenceSection = WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry }

/** Everything the row builder reads. Pure data: no store, clock or client-specific state. */
export type SidebarRowPlanInputs = {
  groupBy: WorktreeGroupBy
  sortBy: WorkspaceSortBy
  /** Visible worktrees in the frozen sort order. */
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  /** Defaults to repoMap's registration for the row's repo id. */
  repoOfWorktree?: RepoOfWorktree
  prGroupOf: SidebarPRGroupReader
  repoOrder?: Map<string, number>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectOrderBy: ProjectOrderBy
  lineageById: Record<string, WorktreeLineage>
  /** Parents resolved once over every visible store's complete rows; nesting reuses them. */
  lineageParentIdentities?: SidebarLineageParentIdentities
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
    sortBy,
    worktrees,
    repoMap,
    repoOfWorktree,
    prGroupOf,
    repoOrder,
    workspaceStatuses,
    projectOrderBy,
    lineageById,
    lineageParentIdentities,
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
  const workspaceStatusById =
    groupBy === 'workspace-status' ? buildWorkspaceStatusLookup(workspaceStatuses) : undefined
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  const repoByHost = inputs.repos ? getProjectSectionRepoLookup(inputs.repos) : undefined
  const repoOf = repoOfWorktree ?? ((worktree: Worktree) => repoMap.get(worktree.repoId))
  // Resolve folder membership before groupBy; every mode renders the same set (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const pendingByRepo = groupPendingCreationsByRepo(pendingCreations, repoMap)

  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  // Folder rows are occurrences too, so a folder parent nests its children like any other row.
  const folders = getSidebarFolderOccurrences(renderableFolderWorkspaces)
  const lineageChildren = nestLineage
    ? getSidebarLineageChildren(
        worktrees,
        lineageById,
        worktreeMap,
        filterRepoIds,
        lineageParentIdentities,
        folders.rows
      )
    : new Map<string, Worktree[]>()
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: [...worktrees, ...folders.rows],
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: lineageChildren,
    isPinned: (worktree) => worktree.isPinned === true && !folders.isFolder(worktree),
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionOf: (worktree) =>
      getProjectGroupingForRepo(
        worktree.repoId,
        repoMap,
        projectIndex,
        getWorktreeExecutionHostId(worktree, repoOf(worktree)),
        repoByHost
      ),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) => {
      const folderBound =
        groupBy === 'repo'
          ? folders.boundRowsByGroupId(natural, displayRootByIdentity, lineageChildren)
          : null
      // Rows under a folder still count in their own projects; only their display moves.
      const naturalWorktrees = natural.filter((row) => !folders.isFolder(row))
      const groups: OrderedGroupEntry[] =
        groupBy === 'none'
          ? [[ALL_GROUP_KEY, { label: '', items: naturalWorktrees, repoIds: new Set() }]]
          : buildOrderedGroups({
              groupBy,
              naturalWorktrees,
              repoMap,
              repos: inputs.repos,
              prGroupOf,
              workspaceStatuses,
              workspaceStatusById,
              projectIndex,
              displayRootByIdentity: folderBound?.groupingRootByIdentity ?? displayRootByIdentity,
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
      const sections = groups.map(([key, group]): SidebarOccurrenceSection => {
        const revealPath =
          groupBy === 'repo' && key !== PINNED_GROUP_KEY && group.repo?.projectGroupId
            ? projectGroupPaths.get(group.repo.projectGroupId)
            : undefined
        const items = (
          groupBy === 'repo' && key !== PINNED_GROUP_KEY
            ? orderMainWorktreeFirst(group.items, sortBy)
            : group.items
        ).filter((row) => key === PINNED_GROUP_KEY || !folderBound?.bound.has(row))
        return {
          key,
          group,
          placement: key === PINNED_GROUP_KEY ? 'pinned' : 'natural',
          // Folder rows follow the lane's worktrees, as their rows always have.
          items:
            key === ALL_GROUP_KEY
              ? [...items, ...folders.rows]
              : [...items, ...folders.rowsOf(group.folderWorkspaces)],
          revealPath: { key, parent: revealPath }
        }
      })
      return [...sections, ...getFolderLaneSections(folderBound, projectGroupPaths)]
    }
  })
  const { pinnedSectionWorktrees, orderedGroups, naturalWorktrees } = getOrderedOccurrenceGroups(
    occurrencePlan.sections
  )
  const render = (collapsedGroups: Set<string>): Row[] => {
    const result: Row[] = []
    if (groupBy !== 'repo') {
      for (const creation of pendingCreations) {
        result.push(buildPendingCreationRow(creation, repoMap, repoByHost))
      }
    }
    // Include pinned-only rows when testing mixed hosts or pinned remotes lose host labels.
    const mixedWorktreeHostContextLabels = getMixedWorktreeHostContextLabels(
      worktrees,
      renderableFolderWorkspaces,
      repoOf,
      hostLabelById,
      defaultHostId
    )
    // Project ambiguity is independent of section/host filters; repoMap decides it, candidate maps gate notice eligibility.
    const noticeHostContextLabelByRepoId = getNoticeHostContextLabels(
      [...importedWorktreesByRepo.values(), ...newExternalWorktreesInboxByRepo.values()].map(
        (candidate) => candidate.repo
      ),
      inputs.repos ?? repoMap.values(),
      repoMap,
      projectIndex,
      hostLabelById
    )
    emitPinnedGroup(
      pinnedSectionWorktrees,
      repoOf,
      defaultHostId,
      collapsedGroups,
      result,
      occurrencePlan,
      mixedWorktreeHostContextLabels
    )
    const withImportedLines = (rows: Row[]): Row[] =>
      appendImportedWorktreeLines(rows, { importedWorktreesByRepo, defaultHostId, hostLabelById })
    if (groupBy === 'none') {
      appendUngroupedWorkspaceRows({
        naturalWorktrees,
        renderableFolderWorkspaces,
        repoOf,
        defaultHostId,
        collapsedGroups,
        occurrencePlan,
        mixedWorktreeHostContextLabels,
        folderPairByIdentity: folders.pairByIdentity,
        result
      })
      return withImportedLines(result)
    }

    const sectionContext: SectionAppendContext = {
      result,
      groupBy,
      collapsedGroups,
      workspaceStatuses,
      workspaceStatusById,
      repoMap,
      repoOf,
      defaultHostId,
      hostLabelById,
      projectIndex,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo,
      pendingByRepo,
      repoByHost,
      mixedWorktreeHostContextLabels,
      noticeHostContextLabelByRepoId,
      occurrencePlan,
      folderPairByIdentity: folders.pairByIdentity
    }

    if (groupBy !== 'repo' || projectGroups.length === 0) {
      appendOrderedGroups(
        sectionContext,
        groupBy === 'repo' ? withRepoSectionDisplayLabels(orderedGroups) : orderedGroups
      )
      return groupBy === 'repo' ? result : withImportedLines(result)
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
  const headerRevealPaths = new Map([...projectGroupPaths.values()].map((path) => [path.key, path]))
  for (const section of occurrencePlan.sections) {
    headerRevealPaths.set(section.key, section.revealPath ?? { key: section.key })
  }
  return { occurrencePlan, headerRevealPaths, render }
}
