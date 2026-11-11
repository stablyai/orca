// A send the host kept as a card is drawn only as that card: the rule rides on the submission's
// own fact, never on the card still being there.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from '../requests/structured-agent-session-send-mutation'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const KEPT_ID = 'client-kept'

function rejected(fields: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: KEPT_ID,
    fence: 1,
    payloadFingerprint: 'fingerprint-kept',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'Orca restarted before this message was sent.',
    rejection: { kind: 'hostRestarted' },
    submittedAt: 1,
    resolvedAt: 2,
    ...fields
  }
}

function userItem(id: string, text: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

/** The sending desktop's own bubble, had it not settled yet. */
const lingeringCopy = {
  clientMessageId: KEPT_ID,
  body: structuredAgentSessionSendBody('the kept words', []),
  queuedAt: 1
}

describe('a send kept as a card', () => {
  it('shows nothing of the original send, even beside its own local copy', () => {
    const kept = rejected({ keptAsQueuedMessageId: KEPT_ID })
    const items = [userItem(KEPT_ID, 'the kept words', 1)]
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [kept])).toEqual([])
    // A rejection with no card is drawn from the host's row, marked not sent.
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [rejected()])).toEqual([
      expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true })
    ])
  })
})
