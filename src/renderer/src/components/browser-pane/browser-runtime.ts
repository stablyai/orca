const liveBrowserUrlByTabId = new Map<string, string>()

export function rememberLiveBrowserUrl(browserTabId: string, url: string): void {
  liveBrowserUrlByTabId.set(browserTabId, url)
}

export function getLiveBrowserUrl(browserTabId: string): string | null {
  return liveBrowserUrlByTabId.get(browserTabId) ?? null
}

export function clearLiveBrowserUrl(browserTabId: string): void {
  liveBrowserUrlByTabId.delete(browserTabId)
}
