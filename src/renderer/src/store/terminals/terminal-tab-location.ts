import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Recovery/remount/budget/native-chat guards must all use terminal rows; unified-index gaps previously erased each remount’s budget and defeated its cap (b5cfc6ca). */
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
