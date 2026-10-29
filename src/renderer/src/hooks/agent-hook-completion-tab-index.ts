import type { useAppStore } from '@/store'
type StoreSnapshot = ReturnType<typeof useAppStore.getState>
type WorktreeTab = NonNullable<StoreSnapshot['tabsByWorktree']>[string][number]
export type TabIndex = ReadonlyMap<string, WorktreeTab>

export function buildTabIndex(tabsByWorktree: StoreSnapshot['tabsByWorktree']): TabIndex {
  const index = new Map<string, WorktreeTab>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      // Preserve first-wins lookup when tab IDs collide across worktrees.
      if (!index.has(tab.id)) {
        index.set(tab.id, tab)
      }
    }
  }
  return index
}

export function resolveTabById(
  state: StoreSnapshot,
  tabId: string,
  tabIndex?: TabIndex
): WorktreeTab | undefined {
  if (tabIndex) {
    return tabIndex.get(tabId)
  }
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    const found = tabs.find((candidate) => candidate.id === tabId)
    if (found) {
      return found
    }
  }
  return undefined
}
