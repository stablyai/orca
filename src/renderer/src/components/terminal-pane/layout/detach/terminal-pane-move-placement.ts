import { focusTerminalTabSurface } from '../../input/focus/focus-terminal-tab-surface'
import {
  isFocusUnclaimed,
  isTerminalTabShown,
  type TerminalTabShownState
} from './terminal-tab-shown'
import type {
  DetachedTerminalPaneTab,
  TerminalPaneNewTabTarget
} from './terminal-pane-tab-detach-steps'

/** A pane moved without a drop lands in a new tab right after its source tab. */
type PlacementState = {
  groupsByWorktree: Readonly<Record<string, readonly { id: string; tabOrder?: string[] }[]>>
  unifiedTabsByWorktree: Readonly<
    Record<
      string,
      readonly { id: string; entityId: string; contentType: string; groupId: string }[]
    >
  >
}

export function newTabTargetBesideSource(
  state: PlacementState,
  worktreeId: string,
  sourceTabId: string
): TerminalPaneNewTabTarget | null {
  const sourceTab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === sourceTabId
  )
  const group = sourceTab
    ? state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === sourceTab.groupId)
    : undefined
  if (!sourceTab || !group) {
    return null
  }
  // Anchored to the source tab, so a reorder while the move is in flight still lands it beside it.
  const sourceIndex = (group.tabOrder ?? []).indexOf(sourceTab.id)
  return sourceIndex === -1
    ? { groupId: group.id }
    : { groupId: group.id, index: sourceIndex + 1, afterTabId: sourceTab.id }
}

/**
 * The user's moved pane takes focus in its new tab, unless by the time focus is delivered (two
 * frames, or later for a chat composer that mounts late) they have moved on: another tab or view,
 * or focus in something other than the source or the new tab.
 */
export function focusMovedPane(
  getState: () => TerminalTabShownState,
  worktreeId: string,
  sourceTabId: string,
  moved: DetachedTerminalPaneTab
): void {
  if (!moved.followed) {
    return
  }
  focusTerminalTabSurface(moved.tab.id, moved.leafId, {
    shouldFocus: () =>
      isTerminalTabShown(getState(), worktreeId, moved.tab.id) &&
      isFocusUnclaimed(sourceTabId, moved.tab.id)
  })
}
