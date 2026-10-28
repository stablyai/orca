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

export type NativeChatRewindHost = {
  /** The host's in-doubt latch, from its status feed. */
  hostBlockedReason?: AgentSessionRewindReason | null
  onMessageReturned?: () => void
  isVisible?: boolean
}

/** Return rewound messages through the pane’s existing composer focus path; expose host uncertainty and read visibility. */
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
