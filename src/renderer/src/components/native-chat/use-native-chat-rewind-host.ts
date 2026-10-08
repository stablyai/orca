import { useCallback, type RefObject } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionRewindBlockedReason } from './StructuredAgentSessionStatusBridge'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import type { NativeChatRewindHost } from './use-native-chat-rewind'

/** What a pane hands its session's rewind: the host's in-doubt latch, its visibility, and where a
 *  returned message lands. `focusComposer` is the same focus the pane's other give-backs use. */
export function useNativeChatRewindHost(
  pane: { sessionId: string; target: RuntimeClientTarget; isVisible: boolean },
  composerRef: RefObject<NativeChatComposerHandle | null>
): { rewindHost: NativeChatRewindHost; focusComposer: () => void } {
  const hostBlockedReason = useStructuredAgentSessionRewindBlockedReason(
    pane.sessionId,
    pane.target
  )
  const focusComposer = useCallback(() => {
    composerRef.current?.focus()
  }, [composerRef])
  return {
    rewindHost: { hostBlockedReason, onMessageReturned: focusComposer, isVisible: pane.isVisible },
    focusComposer
  }
}
