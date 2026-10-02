import type { FolderWorkspace } from '../folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import { buildProjectGroupingIndex, getProjectGroupingForRepo } from '../project-section-grouping'
import type { ProjectSectionModel } from '../project-section-grouping'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { ExecutionHostId } from '../execution-host'
import type { WorktreeLineage } from '../worktree/lineage-types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import {
  buildWorktreeOccurrencePlan,
  type OccurrenceSectionPath,
  type WorktreeOccurrenceSection
} from '../worktree-occurrence-plan'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY, getNestedGroupKey } from './group-keys'
import { getRenderableFolderWorkspaces } from './folder-workspace-lanes'
import { getSidebarLineageChildren } from './pinned-section-worktrees'
import { getProjectGroupOccurrencePaths } from './project-group-sections'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  RepoOfWorktree,
  SidebarPRGroupReader,
  WorktreeGroupBy,
  WorktreeGroupBySecondary,
  WorktreeGroupDimension
} from './row-types'
import { orderMainWorktreeFirst } from './section-order'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { buildOrderedGroups } from './worktree-grouping'

type SidebarOccurrenceSection = WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry }

/** Everything the row builder reads. Pure data: no store, clock or client-specific state. */
export type SidebarRowPlanInputs = {
  groupBy: WorktreeGroupBy
  groupBySecondary?: WorktreeGroupBySecondary
  emptySecondaryStatusSourceGroupKey?: string | null
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

export function buildSidebarRowOccurrencePlan(inputs: SidebarRowPlanInputs) {
  const {
    groupBy,
    groupBySecondary = 'none',
    emptySecondaryStatusSourceGroupKey = null,
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
    pinnedDisplayPolicy,
    filterRepoIds
  } = inputs
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  const repoOf = repoOfWorktree ?? ((worktree: Worktree) => repoMap.get(worktree.repoId))
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  const secondaryGroupBy: WorktreeGroupDimension | null =
    groupBy !== 'none' && groupBySecondary !== 'none' && groupBySecondary !== groupBy
      ? groupBySecondary
      : null
  let plannedPrimaryGroups: OrderedGroupEntry[] = []

  const qualifyProjectGroupPath = (
    path: OccurrenceSectionPath,
    primaryKey: string
  ): OccurrenceSectionPath => {
    const keys: string[] = []
    let current: OccurrenceSectionPath | undefined = path
    while (current) {
      keys.unshift(current.key)
      current = current.parent
    }
    let qualified: OccurrenceSectionPath = { key: primaryKey }
    for (const key of keys) {
      qualified = { key: getNestedGroupKey(primaryKey, key), parent: qualified }
    }
    return qualified
  }

  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: nestLineage
      ? getSidebarLineageChildren(worktrees, lineageById, worktreeMap, filterRepoIds)
      : new Map<string, Worktree[]>(),
    isPinned: (worktree) => worktree.isPinned === true,
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionOf: (worktree) =>
      getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) => {
      const primaryGroups: OrderedGroupEntry[] =
        groupBy === 'none'
          ? [[ALL_GROUP_KEY, { label: '', items: [...natural], repoIds: new Set() }]]
          : buildOrderedGroups({
              groupBy,
              naturalWorktrees: natural,
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
      plannedPrimaryGroups = primaryGroups
      const sections: SidebarOccurrenceSection[] = []
      if (pinned.length > 0) {
        const group = { label: '', items: pinned, repoIds: new Set<string>() }
        sections.push({
          key: PINNED_GROUP_KEY,
          group,
          placement: 'pinned',
          items: pinned,
          revealPath: { key: PINNED_GROUP_KEY }
        })
      }
      for (const [primaryKey, primaryGroup] of primaryGroups) {
        const primaryProjectPath =
          groupBy === 'repo' && primaryGroup.repo?.projectGroupId
            ? projectGroupPaths.get(primaryGroup.repo.projectGroupId)
            : undefined
        const primaryPath = { key: primaryKey, parent: primaryProjectPath }
        if (!secondaryGroupBy) {
          sections.push({
            key: primaryKey,
            group: primaryGroup,
            placement: 'natural',
            items:
              groupBy === 'repo' ? orderMainWorktreeFirst(primaryGroup.items) : primaryGroup.items,
            revealPath: primaryPath
          })
          continue
        }
        const secondaryGroups = buildOrderedGroups({
          groupBy: secondaryGroupBy,
          naturalWorktrees: primaryGroup.items,
          repoMap,
          prGroupOf,
          workspaceStatuses,
          projectIndex,
          placeholderRepoIds: new Set(),
          importedWorktreesByRepo: new Map(),
          newExternalWorktreesInboxByRepo: new Map(),
          pendingByRepo: new Map(),
          repoOrder,
          projectOrderBy,
          folderWorkspaces: primaryGroup.folderWorkspaces ?? [],
          includeEmptyWorkspaceStatusGroups:
            secondaryGroupBy === 'workspace-status' &&
            emptySecondaryStatusSourceGroupKey?.startsWith(`${primaryKey}/workspace-status:`) ===
              true
        })
        for (const [secondaryKey, secondaryGroup] of secondaryGroups) {
          const key = getNestedGroupKey(primaryKey, secondaryKey)
          const secondaryProjectPath =
            secondaryGroupBy === 'repo' && secondaryGroup.repo?.projectGroupId
              ? projectGroupPaths.get(secondaryGroup.repo.projectGroupId)
              : undefined
          sections.push({
            key,
            group: { ...secondaryGroup, sourceKey: secondaryKey },
            placement: 'natural',
            items:
              secondaryGroupBy === 'repo'
                ? orderMainWorktreeFirst(secondaryGroup.items)
                : secondaryGroup.items,
            revealPath: {
              key,
              parent: secondaryProjectPath
                ? qualifyProjectGroupPath(secondaryProjectPath, primaryKey)
                : primaryPath
            }
          })
        }
      }
      return sections
    }
  })
  const pinnedSectionWorktrees =
    occurrencePlan.sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups = plannedPrimaryGroups
  return {
    occurrencePlan,
    orderedGroups,
    naturalWorktrees: orderedGroups.flatMap(([, group]) => group.items),
    pinnedSectionWorktrees,
    projectIndex,
    repoOf,
    renderableFolderWorkspaces,
    pendingByRepo,
    secondaryGroupBy
  }
}
