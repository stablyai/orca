import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { SidebarWorktreeFilters } from './use-filters'
import type { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import type { useSidebarHostVisibleScope } from './use-host-visible-scope'
import type { useSidebarSectionRows } from './use-section-rows'

/** What WorktreeList hands the list model: the store's view settings, catalog and screen state. */
export type SidebarListModelArgs = {
  filterState: SidebarWorktreeFilters['filterState']
  sortBy: SortBy
  groupBy: WorktreeGroupBy
  projectOrderBy: ProjectOrderBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  defaultHostId: ExecutionHostId
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  collapsedGroups: Set<string>
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  allWorktrees: readonly Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGrouping: ProjectGroupingModel
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo']
  prCache: AppState['prCache'] | null
  agentSendTargetWorktreeId: string | null
}

/** The rows WorktreeList renders and what its reveal, selection and cards read beside them. */
export type SidebarListModel = {
  visibleWorktrees: Worktree[]
  visibleScope: ReturnType<typeof useSidebarHostVisibleScope>
  externalWorktreeCards: ReturnType<typeof useSidebarExternalWorktreeCards>
  rowModel: ReturnType<typeof useSidebarSectionRows>
}
