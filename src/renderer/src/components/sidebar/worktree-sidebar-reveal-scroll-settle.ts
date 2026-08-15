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
}

/** Ceiling for a browser smooth-scroll animation; also the escape hatch when the target turns out to be unreachable. */
export const REVEAL_SCROLL_SETTLE_TIMEOUT_MS = 1000

const SETTLED_TOLERANCE_PX = 1

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
  if (!pending || now >= pending.expiresAt) {
    return false
  }
  return Math.abs(scrollTop - pending.targetTop) > SETTLED_TOLERANCE_PX
}
