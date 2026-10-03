// @vitest-environment happy-dom

// The chat's notices read the journal's rows only when a row of them says something: a message the
// agent's history showed it never got is one, drawn from its row on a client with no entry for it.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

afterEach(cleanup)

it('says a message the agent never got was not delivered, with no Retry, on a client with no entry', () => {
  const undelivered: AgentJournalSubmission = {
    clientMessageId: 'op-undelivered',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    handedOverAt: 5,
    recovered: true,
    ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), { surface: 'rejection' })
  }
  const { result } = renderHook(() =>
    useStructuredAgentSessionDeliveryNotices(
      {
        retry: vi.fn(),
        retryWaitsForHost: new Set(),
        outbox: [],
        submissions: [undelivered],
        journalItems: [],
        failedHere: new Set()
      },
      'Claude'
    )
  )

  expect(result.current.get(agentJournalSubmissionKey('op-undelivered'))).toEqual({
    text: 'This message was not delivered. Send it again to continue.'
  })
})
