// Share one clock-driven outage reveal schedule between desktop and mobile.

// Clean reconnect measured ~4.1s at 400ms RTT including resubscribe/snapshot/TLS; beyond 5s likely includes a failed attempt.
export const CALM_STATUS_REVEAL_DELAY_MS = 5_000

// Avoid a flash and allow enough time to read the title.
export const CALM_STATUS_MIN_VISIBLE_MS = 2_000

// A quick redrop remains part of the same outage.
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
