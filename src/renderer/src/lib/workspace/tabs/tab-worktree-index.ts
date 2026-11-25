export type TabOwnershipRows = Record<string, readonly { id: string }[]>

// Keep full and projected catalogs cached without retaining replaced snapshots.
const tabWorktreeIndexes = new WeakMap<TabOwnershipRows, Map<string, string>>()

export function getTabIdToWorktreeId(
  tabsByWorktree: TabOwnershipRows | null | undefined
): Map<string, string> {
  if (!tabsByWorktree) {
    return new Map()
  }
  const cached = tabWorktreeIndexes.get(tabsByWorktree)
  if (cached) {
    return cached
  }
  const index = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      index.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexes.set(tabsByWorktree, index)
  return index
}
