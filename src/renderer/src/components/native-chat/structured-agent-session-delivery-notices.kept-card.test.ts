// A send the host kept as a queued card is the card's from then on: its own row says nothing,
// neither "Sending…" nor not sent, whatever phase the desktop's send is still in.

import { expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const KEPT_ID = 'client-kept'

function pendingSend(
  patch: Partial<StructuredAgentSessionPendingSend> = {}
): StructuredAgentSessionPendingSend {
  return {
    clientMessageId: KEPT_ID,
    sessionId: 'session-1',
    body: structuredAgentSessionSendBody('the kept words', []),
    previewUris: [],
    queuedAt: 1,
    phase: 'sending',
    issued: false,
    ...patch
  }
}

const restartRejected: AgentJournalSubmission = {
  clientMessageId: KEPT_ID,
  fence: 2,
  payloadFingerprint: 'fingerprint-kept',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: 'Orca restarted before this message was sent.',
  rejection: { kind: 'hostRestarted' },
  submittedAt: 1,
  resolvedAt: 2,
  recovered: true
}

const kept: AgentJournalSubmission = { ...restartRejected, keptAsQueuedMessageId: KEPT_ID }

function notices(
  send: StructuredAgentSessionPendingSend,
  submissions: readonly AgentJournalSubmission[]
) {
  return structuredAgentSessionDeliveryNotices({
    pending: [send],
    submissions,
    agentName: 'Claude',
    startFailures: []
  })
}

// Still being readied, on its way, or resent under its id after a lost answer.
const SENDS = [
  pendingSend(),
  pendingSend({ issued: true }),
  pendingSend({ phase: 'recorded', issued: true })
]

it('gives a kept send no notice, so it never reads "Sending…" or not sent', () => {
  for (const send of SENDS) {
    expect([...notices(send, [kept])]).toEqual([])
  }
})

it('still says not sent, never "Sending…", for a send rejected without being kept', () => {
  for (const send of SENDS) {
    const notice = notices(send, [restartRejected]).get(agentJournalSubmissionKey(KEPT_ID))
    expect(notice).toMatchObject({ text: expect.any(String) })
    expect(notice).not.toHaveProperty('sending')
  }
})
