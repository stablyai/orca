/** Suppress anchor restoration during smooth reveals because any competing scrollTop write cancels their animation. */
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
