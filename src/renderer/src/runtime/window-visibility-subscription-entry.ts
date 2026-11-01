/** One spec's subscription state inside a parking installation. */
export type SubscriptionEntry = {
  desired: boolean
  generation: number
  visibilityGeneration: number
  pending: Promise<void> | null
  retryAttempt: number
  /** Consecutive short-lived streams; resets only once one stays up past the retry ceiling. */
  endedStreak: number
  establishedAt: number
  retryTimer: ReturnType<typeof setTimeout> | null
  startTimer: ReturnType<typeof setTimeout> | null
  unsubscribe: (() => void) | null
}

export function createWindowVisibilitySubscriptionEntry(): SubscriptionEntry {
  return {
    desired: false,
    generation: 0,
    visibilityGeneration: 0,
    pending: null,
    retryAttempt: 0,
    endedStreak: 0,
    establishedAt: 0,
    retryTimer: null,
    startTimer: null,
    unsubscribe: null
  }
}
