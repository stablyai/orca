import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../structured-agent-session-reducer'

function item(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `t-${sequence}` }] }
  }
}

function page(items: AgentJournalRenderItem[], hasOlder: boolean): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'epoch-a', sequence: oldest },
      newest: { epoch: 'epoch-a', sequence: newest },
      nextCursor: { epoch: 'epoch-a', sequence: oldest }
    },
    liveCursor: { epoch: 'epoch-a', sequence: newest },
    hasOlder,
    hasNewer: false
  }
}

function hydrate(items: AgentJournalRenderItem[], hasOlder = false): StructuredAgentSessionState {
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: { type: 'snapshot', sessionId: 'session-a', fence: 1, page: page(items, hasOlder) }
  })
}

describe('structured agent session item retention', () => {
  it('keeps the anchor on the oldest loaded row when a live batch revises a row older than the window', () => {
    // Tail snapshot of a long session: rows 200..239 loaded, 199 rows older on the host.
    const hydrated = hydrate(
      Array.from({ length: 40 }, (_, index) => item(index + 200)),
      true
    )
    expect(oldestStructuredAgentSessionCursor(hydrated)?.sequence).toBe(200)

    // The host revises row 50 in place; the revision keeps its original sequence.
    const revised = reduceStructuredAgentSession(hydrated, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 240 },
          items: [{ ...item(50), revision: 2 }, item(240)],
          removedItemIds: [],
          submissions: []
        }
      }
    })

    // Anchoring on row 50 would page `before: 50` and never load rows 51..199.
    expect(oldestStructuredAgentSessionCursor(revised)?.sequence).toBe(200)
    expect(revised.items.some((entry) => entry.sequence === 50)).toBe(false)
    expect(revised.items.at(-1)?.sequence).toBe(240)
    expect(revised.cursor?.sequence).toBe(240)
    expect(revised.hasOlder).toBe(true)

    // The page reader serves the row at its current revision once the window reaches it.
    const older = reduceStructuredAgentSession(revised, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch-a', sequence: 200 },
      page: page(
        [{ ...item(50), revision: 2 }, ...Array.from({ length: 149 }, (_, i) => item(i + 51))],
        false
      )
    })
    expect(older.items.find((entry) => entry.sequence === 50)?.revision).toBe(2)
    expect(oldestStructuredAgentSessionCursor(older)?.sequence).toBe(50)
    expect(older.hasOlder).toBe(false)
  })
  it('lets a live chat run 128 rows past its window before trimming back to it', () => {
    let state = hydrate(Array.from({ length: 1024 }, (_, index) => item(index + 1)))
    const append = (sequence: number) => {
      state = reduceStructuredAgentSession(state, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            cursor: { epoch: 'epoch-a', sequence },
            items: [item(sequence)],
            removedItemIds: [],
            submissions: []
          }
        }
      })
    }
    for (let sequence = 1025; sequence <= 1152; sequence += 1) {
      append(sequence)
    }
    expect(state.items).toHaveLength(1152)
    expect(state.items[0]?.sequence).toBe(1)

    append(1153)
    expect(state.items).toHaveLength(1024)
    expect(state.items[0]?.sequence).toBe(130)
    expect(state.hasOlder).toBe(true)
  })
})
