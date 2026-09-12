import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/**
 * The one scan over `tabsByWorktree`. Recovery's remount, its budget release
 * and its native-chat guard must all resolve a tab through this: answering
 * from a different index (getTab's `unifiedTabsByWorktree`) made every remount
 * erase the budget it had just consumed, and the cap never held (crash b5cfc6ca).
 */
export function locateTerminalTab(
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>,
  tabId: string
): { worktreeId: string; index: number; tab: TerminalTab } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const index = tabs.findIndex((candidate) => candidate.id === tabId)
    if (index !== -1) {
      return { worktreeId, index, tab: tabs[index] }
    }
  }
  return null
}
