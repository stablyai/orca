// Stage typed URLs by stable page ID until creation finishes; early RPCs report page-missing and can close the optimistic tab.
const deferredNavigationsByPageId = new Map<string, { url: string; at: number }>()

// Bound abandoned creates; allow the 30s create RPC time to reconcile before expiring the URL.
const DEFERRED_NAVIGATION_TTL_MS = 60_000

function purgeExpiredDeferredNavigations(now: number): void {
  for (const [pageId, entry] of deferredNavigationsByPageId) {
    if (now - entry.at >= DEFERRED_NAVIGATION_TTL_MS) {
      deferredNavigationsByPageId.delete(pageId)
    }
  }
}

export function deferBrowserPageNavigation(pageId: string, url: string): void {
  const now = Date.now()
  purgeExpiredDeferredNavigations(now)
  // Replay only the latest URL typed while creation is pending.
  deferredNavigationsByPageId.set(pageId, { url, at: now })
}

export function consumeBrowserPageDeferredNavigation(pageId: string): string | null {
  const now = Date.now()
  purgeExpiredDeferredNavigations(now)
  const entry = deferredNavigationsByPageId.get(pageId)
  if (!entry) {
    return null
  }
  deferredNavigationsByPageId.delete(pageId)
  return entry.url
}

export function clearBrowserPageDeferredNavigation(pageId: string): void {
  deferredNavigationsByPageId.delete(pageId)
}
