import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  BROWSER_RETENTION_LIMIT,
  selectBrowserRetentionEvictions
} from '../../../../../shared/browser-retention-budget'

// Why 4: every hidden worktree that retains browser guests keeps one Electron
// guest process per page alive purely for instant revisits, so guest memory
// grew linearly with worktrees visited (#12137). Four hidden worktrees covers
// the common switch-back working set; older ones are destroyed and rebuild
// from persisted tab state on the next visit.
export const BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT = BROWSER_RETENTION_LIMIT

// Why no clock: switching worktrees is the signal that a working set went cold,
// so this host never needs to ask how long ago something was used. The headless
// host has no such signal and configures the same budget with an idle window
// (offscreen-browser-page-reclaim.ts).
const HIDDEN_WORKTREE_BUDGET = {
  limit: BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT,
  idleMs: Number.POSITIVE_INFINITY,
  graceMs: 0
}

/**
 * Hidden worktrees whose retained guests fall beyond the budget, LRU-first.
 *
 * orderedWorktreeIds must be most-recently-activated first (LRU order =
 * worktree activation order). Only worktrees that actually hold live guests
 * count toward the limit. The active worktree never counts and is never
 * evicted, so it is left out of the budget entirely. isEvictable is consulted
 * lazily, only for worktrees beyond the limit — a non-evictable one (a guest an
 * automation/mobile controller is actively driving, or one still writing a
 * download) stays retained over budget.
 */
export function selectBrowserGuestEvictionWorktreeIds(args: {
  orderedWorktreeIds: readonly string[]
  activeWorktreeId: string | null
  isRetained: (worktreeId: string) => boolean
  holdsLiveGuests: (worktreeId: string) => boolean
  isEvictable: (worktreeId: string) => boolean
  limit?: number
}): string[] {
  const seen = new Set<string>()
  const candidates: { id: string }[] = []
  for (const worktreeId of args.orderedWorktreeIds) {
    if (seen.has(worktreeId)) {
      continue
    }
    seen.add(worktreeId)
    if (
      worktreeId === args.activeWorktreeId ||
      !args.isRetained(worktreeId) ||
      !args.holdsLiveGuests(worktreeId)
    ) {
      continue
    }
    candidates.push({ id: worktreeId })
  }
  return selectBrowserRetentionEvictions({
    candidates,
    isPinned: (worktreeId) => !args.isEvictable(worktreeId),
    // Why 0: no candidate carries a timestamp, so the clock rules never read it.
    now: 0,
    budget: {
      ...HIDDEN_WORKTREE_BUDGET,
      limit: args.limit ?? HIDDEN_WORKTREE_BUDGET.limit
    }
  })
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
