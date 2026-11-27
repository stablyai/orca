import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session/journal/agent-session-journal-types'
import { indexBotGroupJournal } from './bot-group'

const TURN = 'turn-1'
const REQUEST = 'request-1'
const WAKE = 'wake-1'

function item(
  itemId: string,
  body: AgentJournalRenderItem['body'],
  sequence: number,
  turnScope?: AgentJournalRenderItem['turnScope']
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    body,
    sequence,
    observedAt: sequence,
    ...(turnScope ? { turnScope } : {})
  }
}

function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'body',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  }
}

/** A bot's turn in a group room, woken twice by item updates: the wakeups joined the running
 *  turn instead of opening one, so the room shows that turn once, under the request that opened
 *  it. */
function journal(): { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] } {
  return {
    items: [
      item(
        agentJournalSubmissionKey(REQUEST),
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'do the work' }] },
        1
      ),
      item(
        TURN,
        {
          kind: 'turn',
          turnId: TURN,
          state: 'running',
          userItemId: agentJournalSubmissionKey(REQUEST),
          startedAt: 10
        },
        2
      ),
      item(
        'answer-1',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'working' }] },
        3,
        { kind: 'turn', turnItemId: TURN }
      ),
      item(
        agentJournalSubmissionKey(WAKE),
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'an item changed' }] },
        4,
        { kind: 'turn', turnItemId: TURN }
      ),
      item(
        'answer-2',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'read the change' }] },
        5,
        { kind: 'turn', turnItemId: TURN }
      )
    ],
    submissions: [submission(REQUEST), submission(WAKE)]
  }
}

describe('a group room turn', () => {
  it('shows the turn the request opened once, and nothing of it for a wakeup that joined it', () => {
    const snapshot = journal()
    // The room's operations, in the order the room shows them.
    const index = indexBotGroupJournal(snapshot, [REQUEST, WAKE])
    expect(index.read(REQUEST).map((row) => row.itemId)).toEqual([
      TURN,
      'answer-1',
      agentJournalSubmissionKey(WAKE),
      'answer-2'
    ])
    expect(index.read(WAKE)).toEqual([])
    expect([...index.joined]).toEqual([WAKE])
  })
})
