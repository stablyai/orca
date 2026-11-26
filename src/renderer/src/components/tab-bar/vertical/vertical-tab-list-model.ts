import type { TabBarItem } from '../model/tab-bar-item-model'
import type { TabBarItemActions } from '../model/use-tab-bar-item-actions'

/**
 * Pinned rows from `start` on. Pinning moves a tab into the stored order's pinned prefix
 * (tab-order.ts), so the list groups them at the top like Chrome's pinned tabs.
 */
export function countPinnedRows(items: readonly Pick<TabBarItem, 'isPinned'>[], start = 0): number {
  let end = start
  while (end < items.length && items[end]!.isPinned) {
    end++
  }
  return end - start
}

/** The row focus moves to for a tablist key, wrapping like WAI-ARIA tabs; null leaves the key alone. */
export function nextVerticalTabIndex(key: string, current: number, count: number): number | null {
  if (count === 0) {
    return null
  }
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Keyboard activation for a row, through the same per-kind action its pointer-up uses. */
export function activateTabBarItem(item: TabBarItem, actions: TabBarItemActions): void {
  switch (item.type) {
    case 'terminal':
      actions.activateTerminal(item.id)
      return
    case 'agent-session':
    case 'room':
      actions.activateAgentSession(item.id)
      return
    case 'browser':
      actions.activateBrowserTab(item.id)
      return
    case 'editor':
    case 'simulator':
      actions.activateFile(item.id)
  }
}
