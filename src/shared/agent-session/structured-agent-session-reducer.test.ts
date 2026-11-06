import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './journal/agent-session-journal-types'
import type { AgentSessionHistoryPage } from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
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

function hydrationPage(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = []
): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions,
    window: {
      oldest: items[0] ? { epoch: 'epoch-a', sequence: oldest } : null,
      newest: items.at(-1) ? { epoch: 'epoch-a', sequence: newest } : null,
      nextCursor: { epoch: 'epoch-a', sequence: oldest }
    },
    liveCursor: { epoch: 'epoch-a', sequence: newest },
    hasOlder: false,
    hasNewer: false
  }
}

describe('structured agent session reducer', () => {
  it("orders one journal write's items by their place in it, whatever order they arrive in", () => {
    const at = (id: string, sequence: number, sequenceIndex: number): AgentJournalRenderItem => ({
      ...item(id, sequence),
      ...(sequenceIndex > 0 ? { sequenceIndex } : {})
    })
    const paged = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: hydrationPage([
        item('before', 4),
        at('third', 5, 2),
        at('first', 5, 0),
        at('second', 5, 1)
      ])
    })
    expect(paged.items.map(({ itemId }) => itemId)).toEqual(['before', 'first', 'second', 'third'])
    const live = reduceStructuredAgentSession(paged, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 6 },
          items: [at('next-b', 6, 1), at('next-a', 6, 0)],
          removedItemIds: [],
          submissions: []
        }
      }
    })
    expect(live.items.map(({ itemId }) => itemId).slice(-2)).toEqual(['next-a', 'next-b'])
  })

  it('keeps a prompt suggestion until a frame clears or replaces it', () => {
    const snapshot = (promptSuggestion?: string) =>
      ({
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        ...(promptSuggestion ? { promptSuggestion } : {})
      }) as const
    const batch = (
      state: StructuredAgentSessionState,
      fields: { promptSuggestion?: string | null }
    ) =>
      reduceStructuredAgentSession(state, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: { cursor: state.cursor!, items: [], removedItemIds: [], submissions: [] },
          ...fields
        }
      })
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: snapshot()
    })
    const suggested = batch(initial, { promptSuggestion: 'add a test' })
    expect(suggested.promptSuggestion).toBe('add a test')
    expect(suggested.items).toBe(initial.items)
    expect(batch(suggested, {})).toBe(suggested)
    expect(batch(suggested, { promptSuggestion: null }).promptSuggestion).toBeNull()

    const restated = reduceStructuredAgentSession(suggested, {
      type: 'event',
      event: snapshot('handle floats')
    })
    expect(restated.promptSuggestion).toBe('handle floats')
    // A snapshot replaces the whole state, so one without a suggestion has none.
    expect(
      reduceStructuredAgentSession(restated, { type: 'event', event: snapshot() }).promptSuggestion
    ).toBeUndefined()
  })
})
