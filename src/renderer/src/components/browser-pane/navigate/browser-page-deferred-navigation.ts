// Stage typed URLs by stable page ID until creation finishes; early RPCs report page-missing and can close the optimistic tab.
type Navigation = { url: string; at: number } | { token: symbol }
const deferredNavigationsByPageId = new Map<string, Navigation>()

// Bound abandoned creates; allow the 30s create RPC time to reconcile before expiring the URL.
const DEFERRED_NAVIGATION_TTL_MS = 60_000

function purgeExpiredDeferredNavigations(now: number): void {
  for (const [pageId, entry] of deferredNavigationsByPageId) {
    if ('at' in entry && now - entry.at >= DEFERRED_NAVIGATION_TTL_MS) {
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
  if (!entry || !('url' in entry)) {
    return null
  }
  deferredNavigationsByPageId.delete(pageId)
  return entry.url
}

export function clearBrowserPageDeferredNavigation(pageId: string): void {
  deferredNavigationsByPageId.delete(pageId)
}

/** Protect only the local model while this bounded intent RPC is outstanding; never replay it on mount. */
export function beginBrowserPageInitializationAction(pageId: string): symbol {
  const token = Symbol(pageId)
  deferredNavigationsByPageId.set(pageId, { token })
  return token
}

export function hasBrowserPageInitializationAction(pageId: string, token?: symbol): boolean {
  const entry = deferredNavigationsByPageId.get(pageId)
  return Boolean(entry && 'token' in entry && (token === undefined || entry.token === token))
}

export function endBrowserPageInitializationAction(pageId: string, token?: symbol): boolean {
  if (!hasBrowserPageInitializationAction(pageId, token)) {
    return false
  }
  deferredNavigationsByPageId.delete(pageId)
  return true
}
