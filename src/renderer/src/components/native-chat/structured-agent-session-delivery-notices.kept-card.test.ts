// A send the host kept as a queued card is the card's from then on: its own row says nothing,
// neither "Sending…" nor not sent, whatever state the desktop's saved copy was left in.

import { expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const KEPT_ID = 'client-kept'

function savedCopy(
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: KEPT_ID,
      sessionId: 'session-1',
      text: 'the kept words',
      attachments: [],
      queuedAt: 1
    }),
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
  copy: StructuredAgentSessionOutboxEntry,
  submissions: readonly AgentJournalSubmission[]
) {
  return structuredAgentSessionDeliveryNotices(
    [copy],
    'Claude',
    () => {},
    submissions,
    [],
    new Set()
  )
}

// The saved copy's states after a quit: still going out, resent on its own after a lost answer,
// or already marked not sent.
const COPIES = [
  savedCopy(),
  savedCopy({ state: 'dispatching' }),
  savedCopy({ state: 'unconfirmed', retryAfterUnknownSubmittedAt: null }),
  savedCopy({ state: 'rejected', lastFailure: { kind: 'rejected', reason: 'not sent' } })
]

it('gives a kept send no notice, so its saved copy never reads "Sending…" or not sent', () => {
  for (const copy of COPIES) {
    expect([...notices(copy, [kept])]).toEqual([])
  }
})

it('still says not sent, never "Sending…", for a send rejected without being kept', () => {
  for (const copy of COPIES) {
    const notice = notices(copy, [restartRejected]).get(agentJournalSubmissionKey(KEPT_ID))
    expect(notice).toMatchObject({ text: expect.any(String) })
    expect(notice).not.toHaveProperty('sending')
  }
})
