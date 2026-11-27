import {
  normalizeBrowserNavigationUrl,
  normalizeKagiSessionLink,
  redactKagiSessionToken
} from './browser-url'

export function createKagiPrivateNavigationQueue() {
  const MAX_PENDING_NAVIGATIONS = 128
  const PENDING_NAVIGATION_TTL_MS = 5 * 60_000
  const pendingNavigations = new Map<
    string,
    { expectedModelUrl: string; navigationUrl: string; expiresAt: number }
  >()
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  function expirePendingNavigations(): void {
    const now = Date.now()
    for (const [pageId, pending] of pendingNavigations) {
      if (pending.expiresAt <= now) {
        pendingNavigations.delete(pageId)
      }
    }
    scheduleExpiry()
  }

  function scheduleExpiry(): void {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    const expiresAt = Math.min(
      ...[...pendingNavigations.values()].map((pending) => pending.expiresAt)
    )
    if (Number.isFinite(expiresAt)) {
      expiryTimer = setTimeout(expirePendingNavigations, Math.max(0, expiresAt - Date.now()))
    }
  }

  function queue(pageId: string, rawUrl: string): void {
    discard(pageId)
    const url = normalizeBrowserNavigationUrl(rawUrl.trim()) ?? rawUrl.trim()
    if (!normalizeKagiSessionLink(url)) {
      return
    }
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token') ?? ''
    // Keep the requested query/fragment; only collapse duplicate or padded bearer values.
    if (parsed.searchParams.getAll('token').length > 1 || token !== token.trim()) {
      let retainedToken = false
      parsed.search = parsed.search
        .slice(1)
        .split('&')
        .flatMap((parameter) => {
          const value = new URLSearchParams(parameter).get('token')
          if (value === null) {
            return [parameter]
          }
          if (retainedToken) {
            return []
          }
          retainedToken = true
          return [
            value === token.trim()
              ? parameter
              : `${parameter.split('=')[0]}=${encodeURIComponent(token.trim())}`
          ]
        })
        .join('&')
    }
    pendingNavigations.set(pageId, {
      expectedModelUrl: redactKagiSessionToken(url),
      navigationUrl: parsed.toString(),
      expiresAt: Date.now() + PENDING_NAVIGATION_TTL_MS
    })
    if (pendingNavigations.size > MAX_PENDING_NAVIGATIONS) {
      const oldest = pendingNavigations.keys().next().value
      if (oldest !== undefined) {
        pendingNavigations.delete(oldest)
      }
    }
    scheduleExpiry()
  }

  function take(pageId: string, modelUrl: string, fallbackUrl = modelUrl): string {
    const pending = pendingNavigations.get(pageId)
    discard(pageId)
    if (!pending) {
      return redactKagiSessionToken(fallbackUrl)
    }
    const safeUrl = redactKagiSessionToken(modelUrl)
    return pending && pending.expiresAt > Date.now() && pending.expectedModelUrl === safeUrl
      ? pending.navigationUrl
      : safeUrl
  }

  function discard(pageId: string): void {
    if (pendingNavigations.delete(pageId)) {
      scheduleExpiry()
    }
  }
  return { queue, take, discard }
}
