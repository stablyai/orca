import type { Worktree } from '../../../../shared/types'
import type { AppState } from '@/store/types'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { buildRows, getPinnedWorktreeDisplayPolicy } from './worktree-list-groups'
import { addHostSectionRows } from './host-section-rows'
import { orderHostSectionOptions } from './host-section-order'
import { buildSidebarHostOptions } from './sidebar-host-options'
import { getLogicalRepoOrderRankById } from './project-header-drop'
import { getRenderedWorktreesInSidebarOrder } from './worktree-sidebar-row-preference'
import { selectWorktreeListReviewCacheInputs } from './worktree-list-review-cache-inputs'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from './worktree-list-host-filtering'

const EMPTY_REPO_ID_SET: ReadonlySet<string> = Object.freeze(new Set<string>())
const EMPTY_IMPORTED_BY_REPO = Object.freeze(new Map()) as never
const EMPTY_INBOX_BY_REPO = Object.freeze(new Map()) as never
const EMPTY_PENDING_CREATIONS = Object.freeze([]) as never

/**
 * Orders already-filtered worktrees the way the sidebar would render them, for
 * Cmd+1–9 numbering while WorktreeList is unmounted (#9497).
 *
 * Why replay the pipeline: a flat list drops grouping, pinning, main-worktree
 * hoisting and collapse elision, so the shortcut numbered the wrong card.
 * Why worktrees are passed in: keeps the dependency on visible-worktrees.ts
 * one-way, since test suites mock that module's path.
 */
export function computeRenderedSidebarWorktreeOrder(
  state: AppState,
  visibleWorktrees: readonly Worktree[]
): string[] {
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const pinnedDisplayPolicy = getPinnedWorktreeDisplayPolicy(state.settings)
  const projection = getProjectHostSetupProjectionFromState(state)
  const visibleHostIdSet = getVisibleSidebarHostIdSet(
    state.visibleWorkspaceHostIds,
    state.workspaceHostScope
  )
  const projectGroups = state.projectGroups ?? []
  const { prCache } = selectWorktreeListReviewCacheInputs(
    state,
    state.groupBy,
    state.worktreeCardProperties
  )

  const rows = buildRows(
    state.groupBy,
    [...visibleWorktrees],
    getRepoMapFromState(state),
    prCache,
    state.collapsedGroups,
    getLogicalRepoOrderRankById(state.repos.map((repo) => repo.id)),
    state.workspaceStatuses,
    state.projectOrderBy,
    state.worktreeLineageById,
    getWorktreeMapFromState(state),
    true,
    state.settings,
    filterProjectGroupsForVisibleHosts(projectGroups, visibleHostIdSet, defaultHostId),
    // Why empty: placeholder/imported/inbox/pending inputs never emit item or folder-workspace rows, the only two the order reads.
    EMPTY_REPO_ID_SET,
    EMPTY_IMPORTED_BY_REPO,
    EMPTY_INBOX_BY_REPO,
    EMPTY_PENDING_CREATIONS,
    { projects: projection.projects, projectHostSetups: projection.setups },
    filterFolderWorkspacesForVisibleHosts(
      state.folderWorkspaces,
      projectGroups,
      visibleHostIdSet,
      defaultHostId
    ),
    // Why no hostLabelById: it only feeds display-only host context labels, never row order.
    undefined,
    defaultHostId,
    pinnedDisplayPolicy
  )

  // Why lazy: with no host filter, addHostSectionRows is a pass-through, so skip building the whole host registry on a keystroke.
  // Deliberately a superset of its internal guards — on <=1 host it still no-ops, wasting only the registry build.
  const needsHostSections =
    state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE || state.visibleWorkspaceHostIds != null
  const sectionRows = needsHostSections
    ? addHostSectionRows({
        rows,
        hostOptions: orderHostSectionOptions(
          buildSidebarHostOptions({
            repos: state.repos,
            sshTargetLabels: state.sshTargetLabels,
            sshConnectionStates: state.sshConnectionStates,
            settings: state.settings,
            runtimeEnvironments: state.runtimeEnvironments,
            runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
            hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
          }),
          state.workspaceHostOrder
        ),
        workspaceHostScope: state.workspaceHostScope,
        visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
        defaultHostId,
        collapsedHostKeys: state.collapsedGroups,
        forceCollapseHosts: false,
        preferProjectGrouping: true
      })
    : rows

  return Array.from(
    new Set(
      getRenderedWorktreesInSidebarOrder(sectionRows, pinnedDisplayPolicy).map(
        (worktree) => worktree.id
      )
    )
  )
}
