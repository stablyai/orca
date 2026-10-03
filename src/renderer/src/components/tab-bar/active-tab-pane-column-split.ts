import type { KeybindingActionId } from '../../../../shared/keybindings'
import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { resolveBrowserWorkspaceOwner } from '@/lib/browser-workspace-source-resolution'
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

/** The tab owning a focused browser guest, or null when it is unknown or cannot split. */
export function resolveBrowserSourcePaneColumnTarget(sourceId: string): TabPaneColumnTarget | null {
  const state = useAppStore.getState()
  const owner = resolveBrowserWorkspaceOwner(state, sourceId)
  const tab = owner
    ? (state.unifiedTabsByWorktree[owner.worktreeId] ?? []).find(
        (candidate) =>
          candidate.contentType === 'browser' && candidate.entityId === owner.workspaceId
      )
    : undefined
  if (!tab || !canMoveTabToNewPaneColumn(tab.id, tab.groupId)) {
    return null
  }
  return { unifiedTabId: tab.id, groupId: tab.groupId }
}
