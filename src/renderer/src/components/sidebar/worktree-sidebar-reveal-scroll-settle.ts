/**
 * Tracks a smooth reveal scroll the sidebar issued itself.
 *
 * A smooth scroll animates across many frames, and any other scrollTop write
 * during that window silently cancels it. The sidebar's scroll-anchor restore
 * writes exactly that, so without this the reveal stops a couple of pixels in
 * and the user has to click the reveal button repeatedly.
 */
export type PendingRevealScroll = {
  targetTop: number
  expiresAt: number
  lastScrollTop?: number
  lastMovementAt?: number
}

// Unreachable targets stop waiting unless the browser is still making native progress.
export const REVEAL_SCROLL_SETTLE_TIMEOUT_MS = 1000

const SETTLED_TOLERANCE_PX = 1
const NATIVE_SCROLL_QUIET_MS = 100

export function createPendingRevealScroll(targetTop: number, now: number): PendingRevealScroll {
  return { targetTop, expiresAt: now + REVEAL_SCROLL_SETTLE_TIMEOUT_MS }
}

export function isRevealScrollSettling({
  now,
  pending,
  scrollTop
}: {
  now: number
  pending: PendingRevealScroll | null
  scrollTop: number
}): boolean {
  if (!pending) {
    return false
  }
  if (pending.lastScrollTop !== undefined && scrollTop !== pending.lastScrollTop) {
    pending.lastMovementAt = now
  }
  pending.lastScrollTop = scrollTop
  if (Math.abs(scrollTop - pending.targetTop) <= SETTLED_TOLERANCE_PX) {
    return false
  }
  if (now < pending.expiresAt) {
    return true
  }
  // One unchanged compositor frame does not mean native easing has ended.
  return (
    now < pending.expiresAt + REVEAL_SCROLL_SETTLE_TIMEOUT_MS &&
    pending.lastMovementAt !== undefined &&
    now - pending.lastMovementAt < NATIVE_SCROLL_QUIET_MS
  )
}
