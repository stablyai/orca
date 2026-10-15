import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import { getRenderedWorkspaceRowsInSidebarOrder } from './worktree-sidebar-row-preference'
import {
  filterFolderWorkspacesFromOtherDevices,
  getPairedDeviceIdsByEnvironment
} from './workspace-creator-visibility'
import {
  computeLiveVisibleSidebarWorktrees,
  type VisibleWorktreeShortcutTarget
} from './visible-worktrees'

const NO_COLLAPSED_GROUPS = new Set<string>()

/**
 * The sorted, filtered worktrees WorktreeList last rendered, before row grouping.
 * Why publish: the list freezes its sort between epochs, so a live re-sort can disagree with the screen.
 */
let _publishedSidebarWorktrees: readonly Worktree[] | null = null

export function setPublishedSidebarWorktrees(worktrees: readonly Worktree[] | null): void {
  _publishedSidebarWorktrees = worktrees
}

/**
 * Workspaces top-to-bottom as the sidebar orders them, including members of collapsed
 * groups (attention there is still wanted) and keeping a pinned workspace at its Pinned slot.
 */
export function computeAttentionOrderWorkspaceTargets(
  state: AppState,
  sidebarWorktrees: readonly Worktree[]
): VisibleWorktreeShortcutTarget[] {
  // Why: the row replay only filters folders by host; the sidebar also hides other devices' folders.
  const folderWorkspaces = state.hideWorkspacesFromOtherDevices
    ? filterFolderWorkspacesFromOtherDevices(
        state.folderWorkspaces,
        getPairedDeviceIdsByEnvironment(
          state.runtimeEnvironments,
          state.runtimeStatusByEnvironmentId
        )
      )
    : state.folderWorkspaces
  const rows = computeRenderedSidebarRows(
    { ...state, folderWorkspaces, collapsedGroups: NO_COLLAPSED_GROUPS },
    sidebarWorktrees
  )
  // Why single-location: it keeps each workspace's first row, so a pinned copy wins over its group copy.
  // Why the resolved host: a local row carries no hostId, but the active workspace records the host it resolved to.
  return getRenderedWorkspaceRowsInSidebarOrder(rows, 'single-location').map((row) => ({
    id: row.worktree.id,
    executionHostId: getWorktreeExecutionHostId(row.worktree, row.repo)
  }))
}

export function getAttentionOrderWorkspaceTargets(): VisibleWorktreeShortcutTarget[] {
  const state = useAppStore.getState()
  return computeAttentionOrderWorkspaceTargets(
    state,
    _publishedSidebarWorktrees ?? computeLiveVisibleSidebarWorktrees(state)
  )
}
