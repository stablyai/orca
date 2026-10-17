import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import { getRenderedWorkspaceRowsInSidebarOrder } from './worktree-sidebar-row-preference'
import {
  filterFolderWorkspacesFromOtherDevices,
  getPairedDeviceIdsByEnvironment
} from '../../../../shared/workspace-creator-visibility'
import { computeLiveVisibleSidebarWorktrees } from './visible-worktrees'

const NO_COLLAPSED_GROUPS = new Set<string>()

const liveRowKey = (worktree: Worktree): string =>
  `${worktree.repoId}\0${worktree.hostId ?? ''}\0${worktree.id}`

export type AttentionOrderWorkspace = {
  id: string
  /** Host the row resolves to: keys identity, since the active workspace records the resolved host. */
  identityHostId: ExecutionHostId
  /** The row's own hostId, passed to activation as-is like Cmd+1–9 so legacy rows find their owner. */
  executionHostId?: ExecutionHostId
  isUnread: boolean
  lastActivityAt: number
}

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
): AttentionOrderWorkspace[] {
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
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  // Why live rows: the published list lags the store by a commit, so its unread flags can be stale.
  const liveRows = new Map(
    getAllWorktreesFromState(state).map((worktree) => [liveRowKey(worktree), worktree])
  )
  return getRenderedWorkspaceRowsInSidebarOrder(rows, 'single-location').map((row) => {
    const identityHostId = getWorktreeExecutionHostId(row.worktree, row.repo, defaultHostId)
    // Why pin local: an unqualified id could otherwise resolve to a same-id remote row first.
    const executionHostId =
      row.worktree.hostId ??
      (identityHostId === LOCAL_EXECUTION_HOST_ID ? identityHostId : undefined)
    const live = liveRows.get(liveRowKey(row.worktree)) ?? row.worktree
    return {
      id: row.worktree.id,
      identityHostId,
      ...(executionHostId ? { executionHostId } : {}),
      isUnread: live.isUnread,
      lastActivityAt: live.lastActivityAt
    }
  })
}

export function getAttentionOrderWorkspaceTargets(): AttentionOrderWorkspace[] {
  const state = useAppStore.getState()
  return computeAttentionOrderWorkspaceTargets(
    state,
    _publishedSidebarWorktrees ?? computeLiveVisibleSidebarWorktrees(state)
  )
}
