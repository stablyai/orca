import { useCallback, useMemo, useState } from 'react'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_SESSION_SIGNED_OUT_RETRY_RUNTIME_CAPABILITY,
  latestNativeChatSignedOutSend,
  nativeChatSignedOutSendCard
} from '../../../../../../../shared/native-chat/native-chat-signed-out-retry'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

/** The chat's delivery notices, plus Retry under a send refused for want of a login; a card has its own Send. */
export function useStructuredAgentSessionRetryableDeliveryNotices(
  { target, sessionId }: { target: RuntimeClientTarget; sessionId: string },
  sends: Pick<
    Parameters<typeof useStructuredAgentSessionDeliveryNotices>[0],
    'pending' | 'submissions' | 'journalItems'
  >,
  wording: Pick<
    Parameters<typeof useStructuredAgentSessionDeliveryNotices>[0],
    'agentName' | 'startFailures'
  >
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { submissions } = sends
  const notices = useStructuredAgentSessionDeliveryNotices({
    pending: sends.pending,
    submissions,
    journalItems: sends.journalItems,
    ...wording
  })
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_SIGNED_OUT_RETRY_RUNTIME_CAPABILITY
  )
  const refused = latestNativeChatSignedOutSend(submissions)
  const offered =
    capability === 'supported' && refused && nativeChatSignedOutSendCard(refused) === null
      ? refused.clientMessageId
      : null
  // Hidden from the press until the host answers; the journal shows the re-sent message.
  const [asked, setAsked] = useState<string | null>(null)
  const retry = useCallback(() => {
    if (offered === null) {
      return
    }
    setAsked(offered)
    void callStructuredAgentSession<{ outcome?: string }>(
      target,
      'agentSession.retrySignedOutSend',
      { sessionId, clientMessageId: offered }
    )
      .catch(() => null)
      .then((answer) => {
        if (answer?.outcome !== 'sent') {
          setAsked((current) => (current === offered ? null : current))
        }
      })
  }, [offered, target, sessionId])
  return useMemo(() => {
    const key = offered === null || asked === offered ? null : agentJournalSubmissionKey(offered)
    const notice = key === null ? undefined : notices.get(key)
    return key !== null && notice?.text !== undefined
      ? new Map(notices).set(key, { ...notice, onRetry: retry })
      : notices
  }, [offered, asked, notices, retry])
}
