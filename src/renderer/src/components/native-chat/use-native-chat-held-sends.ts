import { useEffect, useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-queued-message-wire'
import {
  releaseNativeChatHeldSendsTheHostHolds,
  settleRestoredNativeChatHeldSends
} from './native-chat-held-sends'
import {
  structuredAgentSessionHostHoldsMessage,
  type StructuredAgentSessionHostCopies
} from './structured-agent-session-message-delivery'

const NO_CARDS: readonly AgentSessionQueuedMessage[] = []

/**
 * Keeps the chat's held sends in step with its journal: each one the host holds is dropped, and
 * once the journal first answers after a relaunch, the earlier run's others go back into the box.
 */
export function useNativeChatHeldSends(
  draftKey: string | undefined,
  journal: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    submissions: readonly AgentJournalSubmission[]
    queuedMessages?: readonly AgentSessionQueuedMessage[] | null
  }
): void {
  const { status, submissions, queuedMessages } = journal
  const host = useMemo(
    (): StructuredAgentSessionHostCopies => ({ submissions, cards: queuedMessages ?? NO_CARDS }),
    [queuedMessages, submissions]
  )
  useEffect(() => {
    if (!draftKey || (status !== 'ready' && status !== 'error')) {
      return
    }
    const hostHolds = (clientMessageId: string): boolean =>
      status === 'ready' && structuredAgentSessionHostHoldsMessage(host, clientMessageId)
    settleRestoredNativeChatHeldSends(draftKey, hostHolds)
    releaseNativeChatHeldSendsTheHostHolds(draftKey, hostHolds)
  }, [draftKey, host, status])
}
