import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'
import type { ProjectOrderBy } from '../ui-chrome/ui-chrome-types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { SidebarLineageParentIdentities } from './lineage/worktree-lineage-projection'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host/execution-host'
import type { HiddenProjects } from '../project/catalog/hidden-projects'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './sections/group-keys'
import { appendOrderedGroups, type SectionAppendContext } from './sections/group-sections'

import {
  getLaneHostWorktreeScope,
  getMixedWorktreeHostContextLabels,
  getNoticeHostContextLabels
} from './hosts/host-labels'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  type ProjectSectionModel
} from './sections/project-section-grouping'
import { buildWorktreeOccurrencePlan } from './lineage/worktree-occurrence-plan'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { OrderedGroupEntry } from './sections/worktree-group-entry'

import {
  appendProjectGroupSections,
  getProjectGroupOccurrencePaths
} from './sections/project-group-sections'
import { getSidebarLineageChildren } from './lineage/pinned-section-worktrees'
import { emitPinnedGroup } from './sections/pinned-group-rows'
import { appendWorktreeRows, buildPendingCreationRow } from './sections/row-builders'
import { getRenderableFolderWorkspaces } from './folders/folder-workspace-lanes'
import {
  getSidebarFolderOccurrences,
  isFolderLaneSectionKey
} from './folders/folder-workspace-occurrences'
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
import { appendImportedWorktreeLines } from './sections/imported-worktree-lines'
import { withRepoSectionDisplayLabels } from './sections/project-section-order'
import { buildSidebarOccurrenceSections } from './sections/sidebar-row-plan-sections'
import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

/** Everything the row builder reads. Pure data: no store, clock or client-specific state. */
export type SidebarRowPlanInputs = {
  groupBy: WorktreeGroupBy
  sortBy: WorkspaceSortBy
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
  /** A hidden project's rows reach the plan only under a folder workspace; they never make its section. */
  hiddenProjects?: HiddenProjects
}

const EMPTY_PENDING_BY_REPO = new Map<string, PendingCreationRef[]>()
const EMPTY_LINEAGE_CHILDREN = new Map<string, Worktree[]>()

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
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  const repoOf = repoOfWorktree ?? ((worktree: Worktree) => repoMap.get(worktree.repoId))
  // Resolve folder membership before groupBy; every mode renders the same set (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  let pendingByRepo = EMPTY_PENDING_BY_REPO
  if (pendingCreations.length > 0) {
    pendingByRepo = new Map<string, PendingCreationRef[]>()
    for (const creation of pendingCreations) {
      const list = pendingByRepo.get(creation.repoId)
      if (list) {
        list.push(creation)
      } else {
        pendingByRepo.set(creation.repoId, [creation])
      }
    }
  }

  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  // Folder rows are occurrences too, so a folder parent nests its children like any other row.
  const folders = getSidebarFolderOccurrences(renderableFolderWorkspaces, inputs.hiddenProjects)
  const lineageChildren = nestLineage
    ? getSidebarLineageChildren(
        worktrees,
        lineageById,
        worktreeMap,
        filterRepoIds,
        lineageParentIdentities,
        folders.rows
      )
    : EMPTY_LINEAGE_CHILDREN
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: folders.withPlacedRows(worktrees, lineageChildren),
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: lineageChildren,
    isPinned: (worktree) => worktree.isPinned === true && !folders.isFolder(worktree),
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionKeyOf: (worktree) =>
      getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex).key,
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) =>
      buildSidebarOccurrenceSections({
        groupBy,
        sortBy,
        pinned,
        natural,
        displayRootByIdentity,
        folders,
        lineageChildren,
        repoMap,
        prGroupOf,
        workspaceStatuses,
        projectIndex,
        placeholderRepoIds,
        importedWorktreesByRepo,
        newExternalWorktreesInboxByRepo,
        pendingByRepo,
        repoOrder,
        projectOrderBy,
        renderableFolderWorkspaces,
        projectGroupPaths
      })
  })
  const pinnedSectionWorktrees =
    occurrencePlan.sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = []
  for (let i = 0; i < occurrencePlan.sections.length; i += 1) {
    const section = occurrencePlan.sections[i]
    if (section.key !== PINNED_GROUP_KEY && !isFolderLaneSectionKey(section.key)) {
      orderedGroups.push([section.key, section.group])
    }
  }
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
      renderableFolderWorkspaces,
      repoOf,
      hostLabelById,
      defaultHostId
    )
    // Project ambiguity is independent of section/host filters; repoMap decides it, candidate maps gate notice eligibility.
    let noticeHostContextLabelByRepoId: ReturnType<typeof getNoticeHostContextLabels>
    if (importedWorktreesByRepo.size > 0 || newExternalWorktreesInboxByRepo.size > 0) {
      const noticeRepoIds = new Set<string>()
      for (const repoId of importedWorktreesByRepo.keys()) {
        noticeRepoIds.add(repoId)
      }
      for (const repoId of newExternalWorktreesInboxByRepo.keys()) {
        noticeRepoIds.add(repoId)
      }
      noticeHostContextLabelByRepoId = getNoticeHostContextLabels(
        noticeRepoIds,
        repoMap.keys(),
        repoMap,
        projectIndex,
        hostLabelById
      )
    }
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
      const naturalWorktrees =
        orderedGroups.length === 1
          ? orderedGroups[0][1].items
          : orderedGroups.flatMap(([, group]) => group.items)
      // Folder-only accounts must still render flat rows (#15362).
      if (naturalWorktrees.length > 0 || renderableFolderWorkspaces.length > 0) {
        const { hostWorktreeCounts, hostWorktreeIds } = getLaneHostWorktreeScope(
          naturalWorktrees,
          renderableFolderWorkspaces,
          repoOf,
          defaultHostId
        )
        result.push({
          type: 'header',
          key: ALL_GROUP_KEY,
          count: naturalWorktrees.length + renderableFolderWorkspaces.length,
          icon: { kind: 'all' },
          hostWorktreeCounts,
          hostWorktreeIds,
          worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
        })
        if (!collapsedGroups.has(ALL_GROUP_KEY)) {
          appendWorktreeRows(result, repoOf, occurrencePlan, {
            collapsedGroups,
            groupDepth: 0,
            sectionKey: ALL_GROUP_KEY,
            hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels,
            folderPairByIdentity: folders.pairByIdentity
          })
        }
      }
      return withImportedLines(result)
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
  return { occurrencePlan, render }
}
