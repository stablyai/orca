import { useCallback, type RefObject } from 'react'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useStructuredAgentSessionRewindBlockedReason } from '../../session/status/structured-agent-session-status-hooks'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import type { AgentSessionRewindReason } from '../../../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind-reasons'

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
