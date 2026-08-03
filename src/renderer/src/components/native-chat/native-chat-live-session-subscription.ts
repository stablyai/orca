import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatSessionTransport } from './native-chat-session-transport'

export function scheduleNativeChatRetry(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs)
}

export function subscribeNativeChatTransport(
  transport: NativeChatSessionTransport,
  args: Parameters<NativeChatSessionTransport['subscribe']>[0],
  onFrame: Parameters<NativeChatSessionTransport['subscribe']>[1]
): ReturnType<NativeChatSessionTransport['subscribe']> {
  return transport.subscribe(args, onFrame)
}

/** True when `whole`'s first `len` entries are referentially identical to `prefix` (a tail-extension), so the assembler can splice just the suffix. */
export function nativeChatMessagesSharePrefix(
  whole: readonly NativeChatMessage[],
  prefix: readonly NativeChatMessage[],
  len: number
): boolean {
  for (let i = 0; i < len; i += 1) {
    if (whole[i] !== prefix[i]) {
      return false
    }
  }
  return true
}

let subscriptionCounter = 0

export function nextNativeChatSubscriptionId(): string {
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

/** Web RPC bridge returns a Promise (not the desktop sync unsubscribe fn); calling it as a function crashed the view, so resolve first. */
export function closeNativeChatSubscription(unsubscribe: unknown): void {
  if (typeof unsubscribe === 'function') {
    ;(unsubscribe as () => void)()
    return
  }
  if (unsubscribe && typeof (unsubscribe as { then?: unknown }).then === 'function') {
    void (unsubscribe as Promise<unknown>).then((fn) => {
      if (typeof fn === 'function') {
        ;(fn as () => void)()
      }
    })
  }
}
