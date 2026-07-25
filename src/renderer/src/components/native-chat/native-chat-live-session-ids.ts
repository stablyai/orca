// Subscription-id minting and the transcript not-found retry schedule for the
// live-session hook. Split out of use-native-chat-live-session.ts: both are
// module-level policy with no hook state, and the hook file is at its size cap.

let subscriptionCounter = 0

/** Fallback subscription id for callers that do not mint their own (ACP panes do — they address prompts by it). */
export function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

// Why: a new session's transcript can take minutes to appear on disk (#8401); a `notFound` miss retries with backoff until the window below elapses.
const NOTFOUND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const NOTFOUND_RETRY_FIXED_DELAY_MS = 10_000
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

export function notFoundRetryDelayMs(attempt: number): number {
  return NOTFOUND_RETRY_DELAYS_MS[attempt] ?? NOTFOUND_RETRY_FIXED_DELAY_MS
}
