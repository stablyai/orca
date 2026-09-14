import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionHistoryPage } from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

const CAP = 1024

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

function streamItems(
  state: StructuredAgentSessionState,
  sequences: number[]
): StructuredAgentSessionState {
  return sequences.reduce(
    (current, sequence) =>
      reduceStructuredAgentSession(current, {
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
      }),
    state
  )
}

describe('structured agent session item retention', () => {
  it('bounds retained items on a long live session', () => {
    const streamed = streamItems(
      hydrate([item(0)]),
      Array.from({ length: CAP + 500 }, (_, index) => index + 1)
    )

    expect(streamed.items).toHaveLength(CAP)
    expect(streamed.items.at(-1)?.sequence).toBe(CAP + 500)
    expect(streamed.items[0]?.sequence).toBe(501)
  })

  it('offers paging for items the cap dropped', () => {
    const streamed = streamItems(
      hydrate([item(0)]),
      Array.from({ length: CAP + 10 }, (_, index) => index + 1)
    )

    expect(streamed.hasOlder).toBe(true)
    expect(oldestStructuredAgentSessionCursor(streamed)).toEqual({
      epoch: 'epoch-a',
      sequence: streamed.items[0]?.sequence
    })
  })

  it('leaves a session under the cap untouched', () => {
    const hydrated = hydrate([item(0)])
    const streamed = streamItems(
      hydrated,
      Array.from({ length: 200 }, (_, index) => index + 1)
    )

    expect(streamed.items).toHaveLength(201)
    expect(streamed.hasOlder).toBe(false)
  })

  it('widens the retained window when older items are paged in', () => {
    const streamed = streamItems(
      hydrate([item(1_000)], true),
      Array.from({ length: CAP + 10 }, (_, index) => index + 1_001)
    )
    const older = reduceStructuredAgentSession(streamed, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch-a', sequence: streamed.items[0]?.sequence ?? 0 },
      page: page(
        Array.from({ length: 300 }, (_, index) => item(index + 700)),
        true
      )
    })
    expect(older.items).toHaveLength(CAP + 300)

    // A live batch slides the widened window by one instead of collapsing it back to the cap.
    const afterLive = streamItems(older, [3_000])

    expect(afterLive.items).toHaveLength(CAP + 300)
    expect(afterLive.items[0]?.sequence).toBe(701)
    expect(afterLive.items.some((entry) => entry.sequence === 800)).toBe(true)
  })

  it('drops an older page whose anchor a live batch trimmed past', () => {
    const streamed = streamItems(
      hydrate([item(0)], false),
      Array.from({ length: CAP + 200 }, (_, index) => index + 1)
    )
    // The read captures this cursor, then a live batch trims three items off the head.
    const anchor = oldestStructuredAgentSessionCursor(streamed)
    const slid = streamItems(streamed, [CAP + 201, CAP + 202, CAP + 203])
    expect(slid.items[0]?.sequence).toBeGreaterThan(anchor?.sequence ?? 0)

    const merged = reduceStructuredAgentSession(slid, {
      type: 'older-page',
      requestedCursor: anchor ?? { epoch: 'epoch-a', sequence: 0 },
      page: page(
        Array.from({ length: 200 }, (_, index) => item((anchor?.sequence ?? 0) - 200 + index)),
        true
      )
    })

    // Merging would have left a hole between the page and the retained window.
    expect(merged).toBe(slid)
  })

  it('accepts an older page whose anchor still matches the retained head', () => {
    const streamed = streamItems(
      hydrate([item(0)], false),
      Array.from({ length: CAP + 200 }, (_, index) => index + 1)
    )
    const anchor = oldestStructuredAgentSessionCursor(streamed)
    const merged = reduceStructuredAgentSession(streamed, {
      type: 'older-page',
      requestedCursor: anchor ?? { epoch: 'epoch-a', sequence: 0 },
      page: page(
        Array.from({ length: 200 }, (_, index) => item((anchor?.sequence ?? 0) - 200 + index)),
        true
      )
    })

    expect(merged.items).toHaveLength(CAP + 200)
    expect(merged.items[0]?.sequence).toBe((anchor?.sequence ?? 0) - 200)
  })

  it('keeps item identity stable when a batch carries no journal change', () => {
    const hydrated = hydrate([item(0)])
    const unchanged = reduceStructuredAgentSession(hydrated, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        fence: 2,
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 0 },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      }
    })

    expect(unchanged.items).toBe(hydrated.items)
  })
})
