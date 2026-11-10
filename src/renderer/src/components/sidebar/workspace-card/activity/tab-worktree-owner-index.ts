let tabWorktreeIndexCache: {
  tabsByWorktree: Record<string, readonly { id: string }[]>
  tabIdToWorktreeId: Map<string, string>
} | null = null

// Settings reuses this tab index to avoid rescanning every bucket on each store write.
export function getTabIdToWorktreeId(
  tabsByWorktree: Record<string, readonly { id: string }[]>
): Map<string, string> {
  if (tabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree) {
    return tabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexCache = { tabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}
