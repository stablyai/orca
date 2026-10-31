import type { PersonalProjectOrder } from '../personal-project-order'
import type { ExecutionHostId, ExecutionHostScope } from '../execution-host'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { WorkspaceRowFilters } from '../workspace-view/workspace-row-filters'
import type { WorkspaceStatusDefinition } from '../worktree/types'
import type { WorktreeGroupBy, PinnedWorktreeDisplayPolicy } from './row-types'
import type { SortBy } from './smart-sort'

/** The host's view settings a reader shows the list with; the host's own phone reads them off ui.get. */
export type SidebarFeedView = {
  groupBy: WorktreeGroupBy
  sortBy: SortBy
  projectOrderBy: ProjectOrderBy
  personalProjectOrder?: PersonalProjectOrder
  collapsedGroups: ReadonlySet<string>
  filters: WorkspaceRowFilters
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  /** The host the desktop has focused (its settings' active runtime), where unowned rows land. */
  defaultHostId: ExecutionHostId
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string>
  /** The listed host's name for itself when the user has not renamed it. */
  localHostLabel: string
  /** The desktop window's own saved host order, which it writes; a phone reads the host's. */
  workspaceHostOrder?: readonly ExecutionHostId[]
}
