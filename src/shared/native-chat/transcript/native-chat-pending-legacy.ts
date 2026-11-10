import type { NativeChatPendingSend } from './native-chat-pending-sends'

/** Release claims from other provider sessions so resumed history cannot retire a newer identical send. */
export function releaseEmptyTranscriptClaims(
  pending: NativeChatPendingSend[],
  sessionId: string | null
): NativeChatPendingSend[] {
  if (
    !pending.some(
      (entry) =>
        entry.afterEmptyTranscriptSessionId !== undefined &&
        entry.afterEmptyTranscriptSessionId !== sessionId
    )
  ) {
    return pending
  }
  return pending.map((entry) => {
    if (
      entry.afterEmptyTranscriptSessionId === undefined ||
      entry.afterEmptyTranscriptSessionId === sessionId
    ) {
      return entry
    }
    const { afterEmptyTranscriptSessionId: _released, ...rest } = entry
    return rest
  })
}
