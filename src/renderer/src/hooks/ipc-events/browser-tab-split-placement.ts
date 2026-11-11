import type { AppState } from '../../store/types'
import type { TabSplitDirection, TabSplitTarget } from '../../store/slices/tabs/tabs-slice-contract'

type SplitPlacementState = Pick<
  AppState,
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
  | 'ensureWorktreeRootGroup'
>

const isCallerTab = (fromTabId: string) => (tab: { id: string; entityId: string }) =>
  tab.id === fromTabId || tab.entityId === fromTabId

// Why: a CLI outside its workspace's directory sends no workspace; the caller's tab still names it.
export function splitCallerWorktreeId(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  fromTabId: string | undefined
): string | undefined {
  if (!fromTabId) {
    return undefined
  }
  return Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
    tabs.some(isCallerTab(fromTabId))
  )?.[0]
}

// The pane a split opens beside: the caller's, else the active one; undefined means the root group.
function liveSplitSourceGroupId(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'>,
  worktreeId: string,
  fromTabId: string | undefined
): string | undefined {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const isLive = (groupId: string | undefined): groupId is string =>
    groupId !== undefined && groups.some((group) => group.id === groupId)
  const callerGroupId = fromTabId
    ? (state.unifiedTabsByWorktree[worktreeId] ?? []).find(isCallerTab(fromTabId))?.groupId
    : undefined
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  return isLive(callerGroupId) ? callerGroupId : isLive(activeGroupId) ? activeGroupId : undefined
}

// Splits beside the caller's terminal, else the active pane, else the root group.
export function browserTabSplitTarget(
  state: SplitPlacementState,
  worktreeId: string,
  direction: TabSplitDirection,
  fromTabId: string | undefined
): TabSplitTarget {
  const sourceGroupId =
    liveSplitSourceGroupId(state, worktreeId, fromTabId) ??
    state.ensureWorktreeRootGroup(worktreeId)
  // Why unfocused: the agent that asked keeps keyboard focus; the page still paints in the new pane.
  return { sourceGroupId, splitDirection: direction, activate: false }
}

// A browser pane beside the split's source takes the new page as a tab, so repeated split opens don't stack panes.
export function existingBrowserPaneGroupId(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'>,
  worktreeId: string,
  fromTabId: string | undefined,
  activeBrowserGroupId: string | undefined
): string | undefined {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const sourceGroupId = liveSplitSourceGroupId(state, worktreeId, fromTabId)
  const isOtherLivePane = (groupId: string | undefined): groupId is string =>
    groupId !== undefined &&
    groupId !== sourceGroupId &&
    groups.some((group) => group.id === groupId)
  if (isOtherLivePane(activeBrowserGroupId)) {
    return activeBrowserGroupId
  }
  return tabs.find((tab) => tab.contentType === 'browser' && isOtherLivePane(tab.groupId))?.groupId
}
