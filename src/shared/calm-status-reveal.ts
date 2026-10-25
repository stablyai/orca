/**
 * When a self-healing outage is worth announcing, and for how long. Pure and clock-driven so the
 * desktop banner and the mobile header share one schedule and tests need no wall clock.
 */

// Why 5 s: measured drop-to-resubscribed for the shared control socket through a delay proxy was
// ~0.3 s + 5.5 RTT (1.4 s at 200 ms RTT, 2.5 s at 400 ms). A pane's own resubscribe and snapshot
// add ~2 RTT, and a relay's TLS ~2 more: ~4.1 s for one clean reconnect at 400 ms. Anything
// longer means an attempt failed, which is an outage worth saying.
export const CALM_STATUS_REVEAL_DELAY_MS = 5_000

// Why: shorter than this reads as a flash; long enough to finish reading a title.
export const CALM_STATUS_MIN_VISIBLE_MS = 2_000

// Why: a link that answers and drops again inside this window is one outage, not two.
export const CALM_STATUS_HEALTHY_HOLD_MS = 1_000

export type CalmStatusReveal = {
  downSince: number | null
  shownAt: number | null
  healthySince: number | null
}

export const CALM_STATUS_IDLE: CalmStatusReveal = {
  downSince: null,
  shownAt: null,
  healthySince: null
}

export type CalmStatusStep = {
  next: CalmStatusReveal
  visible: boolean
  /** When the answer can next change on its own; null when only new input can change it. */
  recheckInMs: number | null
}

export function stepCalmStatusReveal(
  previous: CalmStatusReveal,
  input: {
    down: boolean
    immediate: boolean
    now: number
    /** An outage start another observer already saw; the clock continues from it. */
    since?: number | null
  }
): CalmStatusStep {
  const { now } = input
  if (input.down) {
    const downSince = previous.downSince ?? Math.min(input.since ?? now, now)
    const shownAt =
      previous.shownAt ??
      (input.immediate || now - downSince >= CALM_STATUS_REVEAL_DELAY_MS ? now : null)
    return {
      next: { downSince, shownAt, healthySince: null },
      visible: shownAt !== null,
      recheckInMs: shownAt === null ? downSince + CALM_STATUS_REVEAL_DELAY_MS - now : null
    }
  }
  if (previous.downSince === null) {
    return { next: CALM_STATUS_IDLE, visible: false, recheckInMs: null }
  }
  const healthySince = previous.healthySince ?? now
  const hideAt = Math.max(
    healthySince + CALM_STATUS_HEALTHY_HOLD_MS,
    previous.shownAt === null ? 0 : previous.shownAt + CALM_STATUS_MIN_VISIBLE_MS
  )
  if (now >= hideAt) {
    return { next: CALM_STATUS_IDLE, visible: false, recheckInMs: null }
  }
  return {
    next: { ...previous, healthySince },
    visible: previous.shownAt !== null,
    recheckInMs: hideAt - now
  }
}
