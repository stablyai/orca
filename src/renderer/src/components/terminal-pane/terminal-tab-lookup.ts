import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const terminalTabLookupByArray = new WeakMap<readonly TerminalTab[], Map<string, TerminalTab>>()

export function getCachedTerminalTabForWorktree(
  tabsByWorktree: Record<string, TerminalTab[]>,
  worktreeId: string,
  tabId: string
): TerminalTab | null {
  const tabs = tabsByWorktree[worktreeId]
  if (!tabs) {
    return null
  }
  let lookup = terminalTabLookupByArray.get(tabs)
  if (!lookup) {
    // Build one immutable-array index so every mounted pane can find its tab without repeated linear scans.
    lookup = new Map()
    for (const tab of tabs) {
      lookup.set(tab.id, tab)
    }
    terminalTabLookupByArray.set(tabs, lookup)
  }
  return lookup.get(tabId) ?? null
}
