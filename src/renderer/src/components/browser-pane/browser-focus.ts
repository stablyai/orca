export type BrowserFocusTarget = 'webview' | 'address-bar'

export type BrowserFocusRequestDetail = {
  pageId: string
  target: BrowserFocusTarget
}

export const ORCA_BROWSER_FOCUS_REQUEST_EVENT = 'orca:browser-focus-request'

const FOCUS_REQUEST_TTL_MS = 30_000

type PendingBrowserFocusRequest = {
  target: BrowserFocusTarget
  expiresAt: number
}

const pendingBrowserFocusByPageId = new Map<string, PendingBrowserFocusRequest>()
let expiredRequestCleanupTimer: ReturnType<typeof setTimeout> | null = null

function clearExpiredRequestCleanupTimerIfIdle(): void {
  if (pendingBrowserFocusByPageId.size > 0 || expiredRequestCleanupTimer === null) {
    return
  }
  clearTimeout(expiredRequestCleanupTimer)
  expiredRequestCleanupTimer = null
}

function purgeExpiredFocusRequests(now = Date.now()): void {
  for (const [pageId, request] of pendingBrowserFocusByPageId) {
    if (request.expiresAt <= now) {
      pendingBrowserFocusByPageId.delete(pageId)
    }
  }
  clearExpiredRequestCleanupTimerIfIdle()
}

function scheduleExpiredRequestCleanup(): void {
  if (expiredRequestCleanupTimer !== null || pendingBrowserFocusByPageId.size === 0) {
    return
  }
  let nextExpiresAt = Infinity
  for (const request of pendingBrowserFocusByPageId.values()) {
    nextExpiresAt = Math.min(nextExpiresAt, request.expiresAt)
  }
  expiredRequestCleanupTimer = setTimeout(
    () => {
      expiredRequestCleanupTimer = null
      purgeExpiredFocusRequests()
      scheduleExpiredRequestCleanup()
    },
    Math.max(0, nextExpiresAt - Date.now())
  )
}

export function queueBrowserFocusRequest(detail: BrowserFocusRequestDetail): void {
  const now = Date.now()
  purgeExpiredFocusRequests(now)
  // Why: focus requests must survive the target browser pane mounting, but a
  // removed page should not leave its id in this module-level queue forever.
  pendingBrowserFocusByPageId.set(detail.pageId, {
    target: detail.target,
    expiresAt: now + FOCUS_REQUEST_TTL_MS
  })
  scheduleExpiredRequestCleanup()
}

export function consumeBrowserFocusRequest(pageId: string): BrowserFocusTarget | null {
  purgeExpiredFocusRequests()
  const pending = pendingBrowserFocusByPageId.get(pageId) ?? null
  if (!pending) {
    return null
  }
  pendingBrowserFocusByPageId.delete(pageId)
  clearExpiredRequestCleanupTimerIfIdle()
  return pending.target
}
