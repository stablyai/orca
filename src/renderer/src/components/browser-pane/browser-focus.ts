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

/** Queue + announce so a mounting browser pane and live listeners both see the request. */
export function requestBrowserFocus(detail: BrowserFocusRequestDetail): void {
  queueBrowserFocusRequest(detail)
  window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
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

export type AgentInputBorrowPhase = 'begin' | 'end'

export type AgentInputFocusBorrowHandlers<T> = {
  /** The element focus should return to, or null when the guest already owns it. */
  captureOwner: () => T | null
  /** Whether the guest actually ended up holding focus. */
  focusGuest: () => boolean
  restore: (owner: T | null) => void
}

/**
 * Tracks the nesting of agent input focus borrows.
 *
 * Why: one agent action nests borrows — typing a single character sends
 * keyDown/char/keyUp, and each announces its own begin/end pair. Recording the
 * owner on every begin would overwrite it with null the second time around (the
 * guest already holds focus by then) and focus would never return to the user.
 * Only the outermost begin captures, and only the outermost end restores.
 *
 * Returns whether the guest holds focus, which only a 'begin' can answer for.
 */
export function createAgentInputFocusBorrow<T>(
  handlers: AgentInputFocusBorrowHandlers<T>
): (phase: AgentInputBorrowPhase) => boolean {
  let owner: T | null = null
  let depth = 0
  return (phase) => {
    if (phase === 'begin') {
      if (depth === 0) {
        owner = handlers.captureOwner()
      }
      // Why: count the borrow even when focus fails, so the matching 'end' still
      // unwinds it instead of leaving the depth stuck above zero forever.
      depth += 1
      return handlers.focusGuest()
    }
    // Why: an 'end' with no matching 'begin' (a command already in flight when this
    // listener mounted) must not drive the counter negative and swallow the next
    // real restore.
    depth = Math.max(0, depth - 1)
    if (depth > 0) {
      return true
    }
    handlers.restore(owner)
    owner = null
    return true
  }
}
