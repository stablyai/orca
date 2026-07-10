import type { TerminalTab } from '../../../../shared/types'

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
    // Why: every mounted TerminalPane asks for its own tab on store updates.
    // Build the per-array lookup once so 200 panes do not repeat the same scan.
    lookup = new Map()
    for (const tab of tabs) {
      lookup.set(tab.id, tab)
    }
    terminalTabLookupByArray.set(tabs, lookup)
  }
  return lookup.get(tabId) ?? null
}
