import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'

// Why 4: every hidden worktree that retains browser guests keeps one Electron
// guest process per page alive purely for instant revisits, so guest memory
// grew linearly with worktrees visited (#12137). Four hidden worktrees covers
// the common switch-back working set; older ones are destroyed and rebuild
// from persisted tab state on the next visit.
export const BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT = 4

/**
 * Hidden worktrees whose retained guests fall beyond the budget, LRU-first.
 *
 * orderedWorktreeIds must be most-recently-activated first (LRU order =
 * worktree activation order). Only worktrees that actually hold live guests
 * count toward the limit. The active worktree never counts and is never
 * evicted. isEvictable is consulted lazily, only for worktrees beyond the
 * limit — a non-evictable one (a guest an automation/mobile controller is
 * actively driving, or one still writing a download) stays retained over
 * budget.
 */
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

// Why the fallback: webviews key by page id, but legacy sessions persisted
// before pages existed key by the workspace tab id (see collectBrowserWebviewIds).
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

// Mirrors BrowserOverlaySlot's page-id derivation so visibility pinning
// (automation-visible / mobile-driven) protects exactly the slots it paints.
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
