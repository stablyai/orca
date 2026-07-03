/**
 * Outbound HTTP that the desktop app routes through Electron's `net.fetch`
 * (Chromium network stack: OS proxy + cert integration, no stale keep-alive
 * after VPN changes). The headless server has no Electron `net`, so it falls
 * back to Node's global `fetch` (undici).
 *
 * Settable singleton so the runtime core can call managedFetch() without
 * importing electron; the desktop process installs the electron-backed impl and
 * the node server leaves the global-fetch default in place.
 */
export type ManagedFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Optional hook to sync proxy config before a request (electron session). */
export type ProxyPrimer = (url: string) => Promise<void>

let fetchImpl: ManagedFetch = (url, init) => fetch(url, init)
let proxyPrimer: ProxyPrimer | null = null

export function setManagedFetch(impl: ManagedFetch): void {
  fetchImpl = impl
}

export function setProxyPrimer(primer: ProxyPrimer | null): void {
  proxyPrimer = primer
}

export async function managedFetch(url: string, init?: RequestInit): Promise<Response> {
  if (proxyPrimer) {
    await proxyPrimer(url).catch(() => {
      // Proxy priming is best-effort; the request below still proceeds.
    })
  }
  return fetchImpl(url, init)
}

export function __resetManagedFetchForTests(): void {
  fetchImpl = (url, init) => fetch(url, init)
  proxyPrimer = null
}
