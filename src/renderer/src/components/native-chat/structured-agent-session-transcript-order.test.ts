import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { projectAgentSessionConversationOutline } from '../../../../shared/agent-session-conversation-outline'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

function journalItem(
  itemId: string,
  sequence: number,
  observedAt: number,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt, body, ...extra }
}

function said(role: 'user' | 'assistant', text: string): AgentJournalItemBody {
  return { kind: 'message', role, blocks: [{ type: 'text', text }] }
}

function answered(question: string): AgentJournalItemBody {
  return {
    kind: 'question',
    question,
    options: [{ id: 'yes', label: 'Yes' }],
    resolution: { state: 'resolved', selectedOptionId: 'yes', resolvedBy: 'client', resolvedAt: 9 }
  }
}

/** The ids the desktop transcript list draws, top to bottom. */
function drawn(
  items: AgentJournalRenderItem[],
  outbox: StructuredAgentSessionOutboxEntry[] = [],
  submissions: AgentJournalSubmission[] = []
): string[] {
  return createNativeChatMessageListProjection()(
    projectStructuredAgentSessionMessages(items, outbox, submissions)
  ).conversation.map(({ id }) => id)
}

function queued(clientMessageId: string, text: string, queuedAt: number) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId,
    sessionId: 'session',
    text,
    attachments: [],
    queuedAt
  })
}

describe('structured transcript order', () => {
  it('draws a row recovered after a crash at its journal position, not its earlier clock', () => {
    // The provider logged the last prompt before the crash; the host journalled it on recovery.
    const items = [
      journalItem('ask', 1, 100, said('user', 'Fix the parser')),
      journalItem('reply', 2, 300, said('assistant', 'Working on it')),
      journalItem('steer', 3, 310, said('user', 'Keep the old API')),
      journalItem('recovered', 4, 200, said('user', 'Also add a test'), {
        recovered: true,
        recoveredAt: 400
      })
    ]
    expect(drawn(items)).toEqual(['ask', 'reply', 'steer', 'recovered'])
    // The host's outline, published to every client, uses the same order.
    expect(projectAgentSessionConversationOutline(items, []).map(({ itemId }) => itemId)).toEqual([
      'ask',
      'steer',
      'recovered'
    ])
  })

  it("draws one write's questions by their place in it, whatever order they arrive in", () => {
    // One Codex ask: a single journal write, one sequence and one timestamp. Neither
    // the ids nor the arrival order below spell the order it was asked in.
    const scope = journalItem('q:scope', 5, 500, answered('Which files?'))
    const priority = journalItem('q:priority', 5, 500, answered('What matters?'), {
      sequenceIndex: 1
    })
    const deadline = journalItem('q:deadline', 5, 500, answered('When?'), { sequenceIndex: 2 })
    expect(drawn([priority, deadline, scope])).toEqual(['q:scope', 'q:priority', 'q:deadline'])
  })

  it('keeps a send the journal does not hold yet below every row it does', () => {
    // The composer's clock can trail the host's; the unsent message still reads last.
    const outbox = [queued('queued', 'One more thing', 150)]
    const items = [
      journalItem('ask', 1, 100, said('user', 'Fix the parser')),
      journalItem('reply', 2, 200, said('assistant', 'Working on it'))
    ]
    expect(drawn(items, outbox)).toEqual(['ask', 'reply', agentJournalSubmissionKey('queued')])
  })

  it('keeps a send the journal recorded and the provider refused at its journal place', () => {
    // The agent kept writing after the refused steer; its Retry stays with the composer.
    const refused = agentJournalSubmissionKey('steer')
    const items = [
      journalItem('ask', 1, 100, said('user', 'Fix the parser')),
      journalItem(refused, 2, 200, said('user', 'Keep the old API')),
      journalItem('reply', 3, 300, said('assistant', 'Done.'))
    ]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'steer',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: 'provider_refused',
        submittedAt: 200,
        resolvedAt: 250
      }
    ]
    expect(
      drawn(
        items,
        [queued('steer', 'Keep the old API', 190), queued('next', 'And docs', 400)],
        submissions
      )
    ).toEqual(['ask', refused, 'reply', agentJournalSubmissionKey('next')])
  })
})
