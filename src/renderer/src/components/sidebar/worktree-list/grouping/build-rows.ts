import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import type { AppState } from '../../../../store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getCyclicProjectedWorktreeLineageIds } from '../../worktree-lineage-projection'
import { ALL_GROUP_KEY, ALL_GROUP_META } from './group-keys'
import { appendOrderedGroups } from './group-sections'
import type { SectionAppendContext } from './group-sections'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedWorktreeHostContextLabels,
  getNoticeHostContextLabels
} from './host-labels'
import { buildProjectGroupingIndex } from './project-grouping'
import type { ProjectGroupingModel } from './project-grouping'
import { appendProjectGroupSections } from './project-group-sections'
import { getPinnedSectionWorktrees } from '../../pinned-section-worktrees'
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
import { getPinnedWorktreeDisplayPolicy } from './row-types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  Row,
  WorktreeGroupBy
} from './row-types'
import { getRenderedNaturalAnchorRepoIds, withRepoSectionDisplayLabels } from './section-order'
import { buildOrderedGroups } from './worktree-grouping'

export function buildRows(
  groupBy: WorktreeGroupBy,
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  collapsedGroups: Set<string>,
  repoOrder?: Map<string, number>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = cloneDefaultWorkspaceStatuses(),
  projectOrderBy: ProjectOrderBy = 'manual',
  lineageById: Record<string, WorktreeLineage> = {},
  worktreeMap = new Map<string, Worktree>(worktrees.map((worktree) => [worktree.id, worktree])),
  nestLineage = false,
  settings?: AppState['settings'],
  projectGroups: readonly ProjectGroup[] = [],
  placeholderRepoIds: ReadonlySet<string> = new Set(),
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate> = new Map(),
  newExternalWorktreesInboxByRepo: ReadonlyMap<
    string,
    NewExternalWorktreesInboxCandidate
  > = new Map(),
  pendingCreations: readonly PendingCreationRef[] = [],
  projectGrouping?: ProjectGroupingModel,
  folderWorkspaces: readonly FolderWorkspace[] = [],
  hostLabelById?: ReadonlyMap<string, string>,
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings)
): Row[] {
  const result: Row[] = []
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  // Membership is decided once, above the groupBy switch: every mode renders the
  // same set of folder workspaces and only chooses where they land (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const cyclicLineageIds = nestLineage
    ? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    : new Set<string>()

  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  // Why: non-repo groupings have no repo section to nest an in-progress create
  // under, so surface them at the very top (where the old global strip sat)
  // rather than dropping them. Repo grouping nests them under their repo below.
  if (groupBy !== 'repo' && pendingCreations.length > 0) {
    for (const creation of pendingCreations) {
      result.push(buildPendingCreationRow(creation, repoMap))
    }
  }

  const pinnedSectionWorktrees = nestLineage
    ? getPinnedSectionWorktrees(worktrees, lineageById, worktreeMap)
    : worktrees.filter((worktree) => worktree.isPinned)
  const pinnedSectionIds = new Set(pinnedSectionWorktrees.map(getWorktreeHostIdentity))
  const naturalWorktrees =
    pinnedDisplayPolicy === 'duplicate-in-groups'
      ? worktrees
      : worktrees.filter((worktree) => !pinnedSectionIds.has(getWorktreeHostIdentity(worktree)))
  const mixedWorktreeHostContextLabels = getMixedWorktreeHostContextLabels(
    naturalWorktrees,
    repoMap,
    hostLabelById,
    defaultHostId
  )
  // Why here and not per section: a notice row can land in the pinned section
  // instead of its project's own, and the host ambiguity it resolves belongs to
  // the project either way. repoMap is the unfiltered universe; the candidate
  // maps are host-filter scoped, so only they gate eligibility.
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
    prCache,
    collapsedGroups,
    workspaceStatuses,
    settings,
    projectGrouping
  })
  emitPinnedGroup(
    pinnedSectionWorktrees,
    repoMap,
    defaultHostId,
    collapsedGroups,
    renderedNaturalAnchorRepoIds,
    importedWorktreesByRepo,
    groupBy !== 'repo',
    result,
    lineageById,
    worktreeMap,
    nestLineage,
    cyclicLineageIds,
    noticeHostContextLabelByRepoId
  )
  if (groupBy === 'none') {
    // Why folder workspaces gate this too: an account with only folder
    // workspaces rendered nothing at all in flat mode before (#15362).
    if (naturalWorktrees.length > 0 || renderableFolderWorkspaces.length > 0) {
      result.push({
        type: 'header',
        key: ALL_GROUP_KEY,
        label: ALL_GROUP_META.label,
        count: naturalWorktrees.length + renderableFolderWorkspaces.length,
        tone: ALL_GROUP_META.tone,
        icon: ALL_GROUP_META.icon,
        hostWorktreeCounts: getLaneHostWorktreeCounts(
          naturalWorktrees,
          renderableFolderWorkspaces,
          repoMap,
          defaultHostId
        ),
        hostWorktreeIds: getLaneHostWorktreeIds(
          naturalWorktrees,
          renderableFolderWorkspaces,
          repoMap,
          defaultHostId
        ),
        worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
      })
      if (!collapsedGroups.has(ALL_GROUP_KEY)) {
        appendWorktreeRows(result, naturalWorktrees, repoMap, lineageById, worktreeMap, {
          nestLineage,
          collapsedGroups,
          groupDepth: 0,
          sectionKey: ALL_GROUP_KEY,
          hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels,
          cyclicLineageIds
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

  const orderedGroups = buildOrderedGroups({
    groupBy,
    naturalWorktrees,
    repoMap,
    prCache,
    settings,
    workspaceStatuses,
    projectIndex,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    folderWorkspaces: renderableFolderWorkspaces
  })

  const sectionContext: SectionAppendContext = {
    result,
    groupBy,
    collapsedGroups,
    workspaceStatuses,
    repoMap,
    defaultHostId,
    hostLabelById,
    projectIndex,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    mixedWorktreeHostContextLabels,
    noticeHostContextLabelByRepoId,
    lineageById,
    worktreeMap,
    nestLineage,
    cyclicLineageIds
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
