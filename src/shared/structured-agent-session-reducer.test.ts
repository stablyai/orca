import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'

function item(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  }
}

describe('structured agent session reducer', () => {
  it('does not let a stale focus refresh replace newer streamed state', () => {
    const streamed = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 50 },
          items: [item('streamed', 50)],
          submissions: []
        }
      }
    })
    const afterRefresh = reduceStructuredAgentSession(streamed, {
      type: 'tail-page',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'tail',
        items: [item('stale', 40)],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 40 },
          newest: { epoch: 'epoch-a', sequence: 40 },
          nextCursor: { epoch: 'epoch-a', sequence: 40 }
        },
        liveCursor: { epoch: 'epoch-a', sequence: 40 },
        hasOlder: true,
        hasNewer: false
      }
    })

    expect(afterRefresh).toBe(streamed)
  })
})
