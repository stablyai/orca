import type { AppState } from '../../store/types'
import type { TabSplitDirection } from '../../store/slices/tabs/tabs-slice-contract'

type SplitPlacementState = Pick<
  AppState,
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
  | 'createEmptySplitGroup'
  | 'ensureWorktreeRootGroup'
>

// Opens an empty pane beside the caller's terminal (or the active pane) and returns its group id.
export function createBrowserTabSplitGroup(
  state: SplitPlacementState,
  worktreeId: string,
  direction: TabSplitDirection,
  fromTabId: string | undefined
): string | null {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const callerGroupId = fromTabId
    ? (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.id === fromTabId || tab.entityId === fromTabId
      )?.groupId
    : undefined
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const sourceGroupId =
    (callerGroupId && groups.some((group) => group.id === callerGroupId) ? callerGroupId : null) ??
    (activeGroupId && groups.some((group) => group.id === activeGroupId) ? activeGroupId : null) ??
    state.ensureWorktreeRootGroup(worktreeId)
  // Why unfocused: the agent that asked keeps keyboard focus; the page still paints in the new pane.
  return state.createEmptySplitGroup(worktreeId, sourceGroupId, direction, { activate: false })
}
