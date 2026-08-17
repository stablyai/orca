import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { createIncrementalAssembler } from './native-chat-incremental-assembler'

// Why: a new session's transcript can take minutes to appear on disk (#8401).
const NOTFOUND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const NOTFOUND_RETRY_FIXED_DELAY_MS = 10_000
export const NATIVE_CHAT_NOTFOUND_RETRY_WINDOW_MS = 60_000

export function nativeChatNotFoundRetryDelayMs(attempt: number): number {
  return NOTFOUND_RETRY_DELAYS_MS[attempt] ?? NOTFOUND_RETRY_FIXED_DELAY_MS
}

// Why: lives outside effect bodies — react-doctor effect-needs-cleanup false-positives
// on setTimeout assigned inside async .then even when cleanup clears the handle.
export function scheduleNativeChatNotFoundRetry(args: {
  attempt: number
  onRetry: () => void
}): ReturnType<typeof setTimeout> {
  return setTimeout(args.onRetry, nativeChatNotFoundRetryDelayMs(args.attempt))
}

export type NativeChatOrderSource = {
  agent: string
  sessionId: string | null
  transcriptPath: string | null
  transport: unknown
}

/** True when a null placeholder adopts its session metadata (keep order gen). */
export function isNativeChatSessionIdAdoption(
  previous: NativeChatOrderSource,
  next: NativeChatOrderSource
): boolean {
  return (
    previous.sessionId === null &&
    next.sessionId != null &&
    previous.agent === next.agent &&
    (previous.transcriptPath === next.transcriptPath || previous.transcriptPath === null) &&
    previous.transport === next.transport
  )
}

/**
 * Gate for settling authoritative frames into transcript order.
 * Adoption settles the first non-empty snapshot; replacements always settle;
 * plain reconnect snapshots do not (baseline rows stay unsequenced).
 */
export function shouldSettleNativeChatAuthoritativeFrame(args: {
  force: boolean
  adoptSettlePending: boolean
  messageCount: number
}): { settle: boolean; adoptSettlePending: boolean } {
  if (!args.force && !args.adoptSettlePending) {
    return { settle: false, adoptSettlePending: args.adoptSettlePending }
  }
  // Empty subscribe snapshot must not consume the post-adoption settle slot.
  if (!args.force && args.messageCount === 0) {
    return { settle: false, adoptSettlePending: args.adoptSettlePending }
  }
  return { settle: true, adoptSettlePending: false }
}

export function createNativeChatAuthoritativeSettle(
  settle: (messages: readonly NativeChatMessage[], retainedCount: number) => void,
  limit: () => number
): {
  settleFrame: (messages: readonly NativeChatMessage[], force: boolean) => void
  markAdoptSettle: () => void
} {
  let adoptSettlePending = false
  return {
    markAdoptSettle: () => {
      adoptSettlePending = true
    },
    settleFrame: (messages, force) => {
      const decision = shouldSettleNativeChatAuthoritativeFrame({
        force,
        adoptSettlePending,
        messageCount: messages.length
      })
      adoptSettlePending = decision.adoptSettlePending
      if (decision.settle) {
        settle(messages, limit())
      }
    }
  }
}

/** Resolve sync or promise-wrapped unsubscribe from transport.subscribe. */
export function teardownNativeChatSubscription(unsubscribe: unknown): void {
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

export type NativeChatAssemblerCache = {
  assembler: ReturnType<typeof createIncrementalAssembler>
  appliedTranscript: readonly NativeChatMessage[]
  baseSig: string | null
  baseMessages: readonly NativeChatMessage[]
}

/** Suffix-append when possible; otherwise full assembler reset. */
export function assembleNativeChatLiveMessages(args: {
  cache: NativeChatAssemblerCache
  baseMessages: readonly NativeChatMessage[]
  appended: readonly NativeChatMessage[]
  agent: string
  sessionId: string | null
  applyAppends: (
    assembler: NativeChatAssemblerCache['assembler'],
    messages: readonly NativeChatMessage[]
  ) => NativeChatMessage[]
  resetAssembler: (
    assembler: NativeChatAssemblerCache['assembler'],
    messages: readonly NativeChatMessage[]
  ) => NativeChatMessage[]
  sharesPrefix: (
    whole: readonly NativeChatMessage[],
    prefix: readonly NativeChatMessage[],
    len: number
  ) => boolean
}): NativeChatMessage[] {
  const { cache, baseMessages, appended, agent, sessionId } = args
  const transcript =
    appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
  const baseSig = `${agent}\u0000${sessionId ?? ''}`
  const baseChanged = baseSig !== cache.baseSig || baseMessages !== cache.baseMessages
  const applied = cache.appliedTranscript
  const isSuffixExtension =
    !baseChanged &&
    transcript.length >= applied.length &&
    args.sharesPrefix(transcript, applied, applied.length)

  let out: NativeChatMessage[]
  if (isSuffixExtension && transcript.length > applied.length) {
    out = args.applyAppends(cache.assembler, transcript.slice(applied.length))
  } else if (isSuffixExtension) {
    out = cache.assembler.messages
  } else {
    out = args.resetAssembler(cache.assembler, transcript)
  }
  cache.baseSig = baseSig
  cache.baseMessages = baseMessages
  cache.appliedTranscript = transcript
  return out
}
