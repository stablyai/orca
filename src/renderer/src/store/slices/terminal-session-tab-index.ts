import type { TerminalTab } from '../../../../shared/types'

// Why: session hydration resolves several tab-keyed records. Index once so
// each layout does not flatten and scan every restored worktree's tabs.
export function indexTerminalSessionTabsById(
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>
): Map<string, TerminalTab> {
  const tabsById = new Map<string, TerminalTab>()
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      // Preserve the former Array.find behavior if corrupted state repeats an ID.
      if (!tabsById.has(tab.id)) {
        tabsById.set(tab.id, tab)
      }
    }
  }
  return tabsById
}
