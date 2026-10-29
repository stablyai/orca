import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'

// Limit idle retained guest processes across hidden worktrees; four covers common revisits while older pages rebuild from persisted state.
export const BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT = 4

/** Evict LRU-first beyond the hidden live-guest budget. Input is most-recent-first; active worktrees never count, and lazy vetoes may retain protected pages over budget. */
export function selectBrowserGuestEvictionWorktreeIds(args: {
  orderedWorktreeIds: readonly string[]
  activeWorktreeId: string | null
  isRetained: (worktreeId: string) => boolean
  holdsLiveGuests: (worktreeId: string) => boolean
  isEvictable: (worktreeId: string) => boolean
  limit?: number
}): string[] {
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT
  const evictedIds: string[] = []
  const seen = new Set<string>()
  let retained = 0
  for (const worktreeId of args.orderedWorktreeIds) {
    if (
      seen.has(worktreeId) ||
      worktreeId === args.activeWorktreeId ||
      !args.isRetained(worktreeId) ||
      !args.holdsLiveGuests(worktreeId)
    ) {
      seen.add(worktreeId)
      continue
    }
    seen.add(worktreeId)
    if (retained < limit) {
      retained += 1
      continue
    }
    if (args.isEvictable(worktreeId)) {
      evictedIds.push(worktreeId)
    }
  }
  return evictedIds
}

// Support legacy sessions whose guests use the workspace tab ID instead of page IDs.
export function worktreeHoldsLiveBrowserGuests(
  browserTabs: readonly BrowserWorkspace[],
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  hasLiveGuest: (browserPageId: string) => boolean
): boolean {
  return browserTabs.some((tab) => {
    const pages = browserPagesByWorkspace[tab.id] ?? []
    if (pages.length === 0) {
      return hasLiveGuest(tab.id)
    }
    return pages.some((page) => hasLiveGuest(page.id))
  })
}

// Match painted slot IDs so automation, mobile and paired-viewer retention protect the same guests.
export function browserTabVisibilityPageIds(tab: BrowserWorkspace): readonly string[] {
  return tab.pageIds && tab.pageIds.length > 0 ? tab.pageIds : [tab.activePageId ?? tab.id]
}

// LRU order = worktree activation order; activating moves the id to the front.
export function touchBrowserGuestWorktreeRecency(recency: string[], worktreeId: string): void {
  const index = recency.indexOf(worktreeId)
  if (index !== -1) {
    recency.splice(index, 1)
  }
  recency.unshift(worktreeId)
}
