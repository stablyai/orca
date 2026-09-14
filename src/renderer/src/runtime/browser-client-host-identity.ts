type BrowserClientHostIdentityApi = {
  browser?: { readClientHostId?: () => string | null }
}

let cachedBrowserClientHostId: string | null = null

/**
 * The id this client's own main process leases browser hosting under, or null where this client
 * hosts nothing — the web client, which installs no page renderer at all. A client-placed page
 * whose placement carries this id is running in a guest webview of ours; any other id names some
 * other client's, and everything that page publishes is all we will ever know about it.
 *
 * Only a real id is cached: a null means the answer was not available yet rather than that this
 * client will never host, and on the web it costs one property read to say so again. The read
 * itself is a scan of the renderer's own argv, so it cannot block and cannot fail late.
 */
export function readBrowserClientHostId(): string | null {
  if (cachedBrowserClientHostId !== null) {
    return cachedBrowserClientHostId
  }
  const api = (globalThis as { api?: BrowserClientHostIdentityApi }).api
  try {
    cachedBrowserClientHostId = api?.browser?.readClientHostId?.() ?? null
  } catch {
    cachedBrowserClientHostId = null
  }
  return cachedBrowserClientHostId
}

export function resetBrowserClientHostIdForTests(): void {
  cachedBrowserClientHostId = null
}
