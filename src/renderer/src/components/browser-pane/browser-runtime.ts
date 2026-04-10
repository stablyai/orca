const liveBrowserUrlByTabId = new Map<string, string>()
const evictedBrowserTabIds = new Set<string>()

export function rememberLiveBrowserUrl(browserTabId: string, url: string): void {
  liveBrowserUrlByTabId.set(browserTabId, url)
}

export function getLiveBrowserUrl(browserTabId: string): string | null {
  return liveBrowserUrlByTabId.get(browserTabId) ?? null
}

export function clearLiveBrowserUrl(browserTabId: string): void {
  liveBrowserUrlByTabId.delete(browserTabId)
}

export function markEvictedBrowserTab(browserTabId: string): void {
  evictedBrowserTabIds.add(browserTabId)
}

export function consumeEvictedBrowserTab(browserTabId: string): boolean {
  const wasEvicted = evictedBrowserTabIds.has(browserTabId)
  if (wasEvicted) {
    evictedBrowserTabIds.delete(browserTabId)
  }
  return wasEvicted
}
