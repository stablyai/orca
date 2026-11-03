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

// Splits beside the caller's terminal, else the active pane, else the root group.
export function browserTabSplitTarget(
  state: SplitPlacementState,
  worktreeId: string,
  direction: TabSplitDirection,
  fromTabId: string | undefined
): TabSplitTarget {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const isLive = (groupId: string | undefined): groupId is string =>
    groupId !== undefined && groups.some((group) => group.id === groupId)
  const callerGroupId = fromTabId
    ? (state.unifiedTabsByWorktree[worktreeId] ?? []).find(isCallerTab(fromTabId))?.groupId
    : undefined
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const sourceGroupId = isLive(callerGroupId)
    ? callerGroupId
    : isLive(activeGroupId)
      ? activeGroupId
      : state.ensureWorktreeRootGroup(worktreeId)
  // Why unfocused: the agent that asked keeps keyboard focus; the page still paints in the new pane.
  return { sourceGroupId, splitDirection: direction, activate: false }
}
