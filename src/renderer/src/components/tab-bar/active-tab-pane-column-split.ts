import type { KeybindingActionId } from '../../../../shared/keybindings'
import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { canMoveTabToNewPaneColumn } from './tab-move-to-pane-column'

export type TabPaneColumnTarget = {
  unifiedTabId: string
  groupId: string
}

export const TAB_SPLIT_SHORTCUT_DIRECTIONS: readonly (readonly [
  KeybindingActionId,
  TabSplitDirection
])[] = [['tab.moveToSplitRight', 'right']]

/** The active tab of a worktree, or null when it cannot be split into a sibling pane column. */
export function resolveActiveTabPaneColumnTarget(
  worktreeId: string | null | undefined
): TabPaneColumnTarget | null {
  if (!worktreeId) {
    return null
  }
  const activeTab = useAppStore.getState().getActiveTab(worktreeId)
  if (!activeTab || !canMoveTabToNewPaneColumn(activeTab.id, activeTab.groupId)) {
    return null
  }
  return { unifiedTabId: activeTab.id, groupId: activeTab.groupId }
}
