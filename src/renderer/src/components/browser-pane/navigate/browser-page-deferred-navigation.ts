// Why this exists: a staged tab shows chrome the user can drive before the host has minted the
// page behind it. Sending browser.goto then resolves nothing, and the browser.tabShow that precedes
// it answers browser_tab_not_found — which the streamed pane reads as "the page is gone" and closes
// the tab out from under the user. The submitted URL is parked here instead, keyed by the page id,
// which survives the staged -> adopted swap, and replayed by whichever pane owns the page once it
// materializes.
const deferredNavigationsByPageId = new Map<string, { url: string; at: number }>()

// Why bounded: a create that never reconciles has its tab rolled back, and nothing else would ever
// come to collect. The window matches the create RPC's own 30s timeout with room to reconcile.
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
  // Why last write wins: the user retyping before the page lands means the newer URL is the one
  // they are waiting on, not both in sequence.
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
