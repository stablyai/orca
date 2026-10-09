// A send the host kept as a card is drawn only as that card: the rule rides on the submission's
// own fact, never on the card still being there.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from './structured-agent-session-send-mutation'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const KEPT_ID = 'client-kept'
// The desktop draws a rejected send in place, as not sent, unless the host kept it as a card.
const DESKTOP = { rejectedInPlace: true }

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
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [kept], DESKTOP)).toEqual(
      []
    )
    // A rejection with no card is drawn from the host's row, marked not sent.
    expect(
      projectStructuredAgentSessionMessages(items, [lingeringCopy], [rejected()], DESKTOP)
    ).toEqual([expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true })])
  })

  // Edit is the card's text in the composer, then the card's Delete, then a new send.
  it('after an Edit sent again, shows exactly the new send', () => {
    const kept = rejected({ keptAsQueuedMessageId: KEPT_ID })
    const edited: AgentJournalSubmission = {
      ...rejected(),
      clientMessageId: 'client-edited',
      dispatchState: 'accepted',
      providerItemId: 'provider-edited',
      reason: null
    }
    delete edited.rejection
    const shown = projectStructuredAgentSessionMessages(
      [userItem(KEPT_ID, 'the kept words', 1), userItem('client-edited', 'the edited words', 2)],
      [lingeringCopy],
      [kept, edited],
      DESKTOP
    )
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ blocks: [{ text: 'the edited words' }] })
    expect(shown[0]).not.toHaveProperty('unsent')
  })
})
