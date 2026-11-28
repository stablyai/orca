import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from '../../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

function pendingSend(
  clientMessageId: string,
  phase: StructuredAgentSessionPendingSend['phase']
): StructuredAgentSessionPendingSend {
  return {
    clientMessageId,
    sessionId: 'chat',
    body: structuredAgentSessionSendBody('hi', []),
    previewUris: [],
    queuedAt: 1,
    phase,
    issued: true
  }
}

function hostRow(clientMessageId: string): AgentJournalSubmission {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the notices read.
  return {
    clientMessageId,
    dispatchState: 'pending',
    submittedAt: 1,
    handoverRecorded: true,
    handedOverAt: 2
  } as AgentJournalSubmission
}

describe('structuredAgentSessionDeliveryNotices', () => {
  // The agent can take minutes to echo a message it already has; that wait is the working line's.
  it('says Sending only until the host records the message', () => {
    const notices = structuredAgentSessionDeliveryNotices({
      pending: [
        pendingSend('awaiting-host', 'sending'),
        pendingSend('host-replied', 'recorded'),
        pendingSend('host-row', 'sending')
      ],
      submissions: [hostRow('host-row'), hostRow('unechoed')],
      agentName: 'Claude',
      startFailures: []
    })
    expect([...notices.keys()]).toEqual([agentJournalSubmissionKey('awaiting-host')])
    expect(notices.get(agentJournalSubmissionKey('awaiting-host'))).toEqual({ sending: true })
  })
})
