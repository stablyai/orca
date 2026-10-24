import { useCallback, type RefObject } from 'react'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionRewindBlockedReason } from './StructuredAgentSessionStatusBridge'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import type { AgentSessionRewindReason } from '../../../../shared/agent-session-rewind'

export type NativeChatRewindSurface = {
  disabledReason: string | null
  eligibleItemIds?: ReadonlySet<string>
  request: (itemId: string, confirm: ConfirmationDialogContextValue) => Promise<void>
}

/** What the pane hosting a structured session tells its rewind. */
export type NativeChatRewindHost = {
  /** The host's in-doubt latch, from its status feed. */
  hostBlockedReason?: AgentSessionRewindReason | null
  onMessageReturned?: () => void
  isVisible?: boolean
}

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
