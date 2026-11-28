import { useCallback } from 'react'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'

/** The context card's Compact action; absent where the session cannot compact or the host holds sends. */
export function useNativeChatCompactContext(
  transport: NativeChatStructuredComposerTransport | undefined
): (() => void) | undefined {
  // A held host refuses conversation commands when typed, so the card does not offer them either.
  const canCompact =
    transport?.conversationCommands?.includes('compact') === true &&
    transport.sendBlockedReason === undefined
  const compact = useCallback(() => {
    if (!transport) {
      return
    }
    // Same path as typing /compact, so its hold, queue and failure rules apply unchanged.
    void transport.dispatchCommand('/compact').then(({ error, refusedWhile }) => {
      if (error) {
        transport.onError(error, refusedWhile ? { refusedWhile } : undefined)
      }
    })
  }, [transport])
  return canCompact ? compact : undefined
}
