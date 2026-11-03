import { useAppStore } from '@/store'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'

/**
 * Move the active workspace tab into a new adjacent pane column.
 * Returns false when the action is a no-op (no active tab / sole tab in group)
 * so callers can skip preventDefault and let the chord fall through.
 */
export function requestActiveTabMoveToSplit(direction: TabSplitDirection = 'right'): boolean {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  const activeTabId = state.activeTabId
  if (!worktreeId || !activeTabId) {
    return false
  }

  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === activeTabId)
  if (!tab?.groupId) {
    return false
  }

  if (!canMoveTabToNewPaneColumn(tab.id, tab.groupId)) {
    return false
  }

  return moveTabToNewPaneColumn({
    unifiedTabId: tab.id,
    groupId: tab.groupId,
    direction
  })
}
