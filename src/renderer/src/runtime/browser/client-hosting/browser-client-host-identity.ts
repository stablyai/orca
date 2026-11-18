type BrowserClientHostIdentityApi = {
  browser?: { readClientHostId?: () => string | null }
}

let cachedBrowserClientHostId: string | null = null

/** Main’s browser-host lease ID identifies our guest webviews; other IDs are observed only through published state. Web clients host none. Cache real IDs only: null can mean startup unavailability. Reads scan renderer argv synchronously, with no blocking/late failure. */
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
