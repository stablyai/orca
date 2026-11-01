import type { AppState } from '@/store/types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import { getPinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  Row,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import type { PRCacheView } from '../../../../../../shared/sidebar-list/workspace-review-facts'
import { createSidebarPRGroupReader } from './pr-group-key'

/** Test-only positional entry to the shared row builder, with the window's defaults. */
export function buildSidebarRowPlan(
  groupBy: WorktreeGroupBy,
  worktrees: Worktree[],
  repoMap: Map<string, Repo>,
  prCache: PRCacheView | null,
  _collapsedGroups: Set<string>,
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
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings),
  filterRepoIds: readonly string[] = []
) {
  return planSidebarRows({
    groupBy,
    worktrees,
    repoMap,
    prGroupOf: createSidebarPRGroupReader(repoMap, prCache),
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
  })
}

export function buildRows(...args: Parameters<typeof buildSidebarRowPlan>): Row[] {
  return buildSidebarRowPlan(...args).render(args[4])
}
