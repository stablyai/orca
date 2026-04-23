import { useAppStore } from '../store'
import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'

/**
 * Handle Cmd/Ctrl+Tab direction switching across terminal, editor, and browser tabs.
 * Extracted from useIpcEvents to keep file size under the max-lines lint threshold.
 * Returns true if a tab switch occurred, false otherwise.
 */
export function handleSwitchTab(direction: number): boolean {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  // Why: walk the active group's visible order so drag-reordered tabs cycle
  // in the sequence the user sees. See getActiveTabNavOrder for the stale
  // legacy-order bug this replaces.
  const allTabIds = getActiveTabNavOrder(store, worktreeId)
  if (allTabIds.length <= 1) {
    return false
  }
  const currentId =
    store.activeTabType === 'editor'
      ? store.activeFileId
      : store.activeTabType === 'browser'
        ? store.activeBrowserTabId
        : store.activeTabId
  const idx = allTabIds.findIndex((t) => t.id === currentId)
  const next = allTabIds[(idx + direction + allTabIds.length) % allTabIds.length]
  if (next.type === 'terminal') {
    store.setActiveTab(next.id)
    store.setActiveTabType('terminal')
  } else if (next.type === 'browser') {
    store.setActiveBrowserTab(next.id)
    store.setActiveTabType('browser')
  } else {
    store.setActiveFile(next.id)
    store.setActiveTabType('editor')
  }
  return true
}
