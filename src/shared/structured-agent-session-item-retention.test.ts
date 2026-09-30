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
const BACKSTOP = 4 * CAP

function item(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `t-${sequence}` }] }
  }
}

/** A row a subagent wrote. */
function childItem(sequence: number): AgentJournalRenderItem {
  return { ...item(sequence), agentId: 'task-1', producerKind: 'agent' }
}

const range = (from: number, length: number): number[] =>
  Array.from({ length }, (_, index) => from + index)

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

/** One live batch per `size` rows, so a burst costs a few merges rather than one per row. */
function streamBatches(
  state: StructuredAgentSessionState,
  rows: AgentJournalRenderItem[],
  size = 1_000
): StructuredAgentSessionState {
  let current = state
  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size)
    current = reduceStructuredAgentSession(current, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: batch.at(-1)?.sequence ?? 0 },
          items: batch,
          removedItemIds: [],
          submissions: []
        }
      }
    })
  }
  return current
}

function streamRevision(
  state: StructuredAgentSessionState,
  row: AgentJournalRenderItem,
  cursorSequence: number
): StructuredAgentSessionState {
  return reduceStructuredAgentSession(state, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 'session-a',
      batch: {
        cursor: { epoch: 'epoch-a', sequence: cursorSequence },
        items: [row],
        removedItemIds: [],
        submissions: []
      }
    }
  })
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

  it('applies a live revision of a row the window holds, including its oldest row', () => {
    const hydrated = hydrate(
      Array.from({ length: 3 }, (_, index) => item(index + 200)),
      true
    )
    const revised = streamRevision(hydrated, { ...item(200), revision: 2 }, 203)

    expect(revised.items.find((entry) => entry.sequence === 200)?.revision).toBe(2)
    expect(oldestStructuredAgentSessionCursor(revised)?.sequence).toBe(200)
  })

  it('admits a live row below the head when nothing older is left on the host', () => {
    // Row 1 was tombstoned before this client attached, so the window starts at 2 and
    // covers the whole journal; a revival of row 1 leaves no hole to skip.
    const hydrated = hydrate(
      Array.from({ length: 3 }, (_, index) => item(index + 2)),
      false
    )
    const revived = streamRevision(hydrated, { ...item(1), revision: 2 }, 5)

    expect(oldestStructuredAgentSessionCursor(revived)?.sequence).toBe(1)
    expect(revived.hasOlder).toBe(false)
  })

  it('counts a live turn-row revision the window could not take, and nothing else', () => {
    const hydrated = hydrate(
      Array.from({ length: 3 }, (_, index) => item(index + 200)),
      true
    )
    const turnRow = (sequence: number, revision: number): AgentJournalRenderItem => ({
      ...item(sequence),
      revision,
      body: { kind: 'turn', turnId: `turn-${sequence}`, state: 'running' }
    })

    const olderMessage = streamRevision(hydrated, { ...item(50), revision: 2 }, 203)
    expect(olderMessage.unloadedTurnRevisions).toBeUndefined()
    const loadedTurn = streamRevision(hydrated, turnRow(201, 2), 203)
    expect(loadedTurn.unloadedTurnRevisions).toBeUndefined()

    const olderTurn = streamRevision(hydrated, turnRow(50, 2), 203)
    expect(olderTurn.items.some((entry) => entry.sequence === 50)).toBe(false)
    expect(olderTurn.unloadedTurnRevisions).toBe(1)
    expect(streamRevision(olderTurn, turnRow(50, 3), 204).unloadedTurnRevisions).toBe(2)
  })

  it('counts a turn row the cap trims out of a live window', () => {
    const turnRow: AgentJournalRenderItem = {
      ...item(0),
      body: { kind: 'turn', turnId: 'turn-0', state: 'running' }
    }
    const full = streamItems(
      hydrate([turnRow]),
      Array.from({ length: CAP - 1 }, (_, index) => index + 1)
    )
    expect(full.unloadedTurnRevisions).toBeUndefined()
    const trimmed = streamItems(full, [CAP])
    expect(trimmed.items[0]?.sequence).toBe(1)
    expect(trimmed.unloadedTurnRevisions).toBe(1)
    expect(streamItems(trimmed, [CAP + 1]).unloadedTurnRevisions).toBe(1)
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

  it("counts the session's own rows, so a subagent's burst keeps the rows before it", () => {
    const streamed = streamBatches(hydrate([item(0), item(1)]), range(2, CAP + 500).map(childItem))

    expect(streamed.items).toHaveLength(CAP + 502)
    expect(streamed.items.slice(0, 2).map(({ itemId }) => itemId)).toEqual(['item-0', 'item-1'])
    expect(streamed.hasOlder).toBe(false)
  })

  it("trims through the oldest own row the limit passes, with the subagent's rows before it", () => {
    const rows = range(1, CAP + 1).flatMap((sequence) =>
      sequence === 1 ? [childItem(sequence)] : [item(sequence)]
    )
    const streamed = streamBatches(hydrate([item(0)]), rows)

    // Own rows 0 and 2..CAP+1 are CAP+1 of them: row 0 goes, and child row 1 after it stays.
    expect(streamed.items[0]?.itemId).toBe('item-1')
    expect(streamed.items).toHaveLength(CAP + 1)
    expect(streamed.hasOlder).toBe(true)
  })

  it("bounds every agent's rows at the backstop, which paging back raises like the limit", () => {
    const streamed = streamBatches(hydrate([item(0)]), range(1, BACKSTOP + 10).map(childItem))

    expect(streamed.items).toHaveLength(BACKSTOP)
    expect(streamed.items.at(-1)?.sequence).toBe(BACKSTOP + 10)
    expect(streamed.hasOlder).toBe(true)

    const older = reduceStructuredAgentSession(streamed, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch-a', sequence: streamed.items[0]?.sequence ?? 0 },
      page: page(range(0, 11).map(childItem), false)
    })
    expect(older.items).toHaveLength(BACKSTOP + 11)
    // A live batch slides the widened window by one instead of collapsing it back to the cap.
    const afterLive = streamBatches(older, [childItem(BACKSTOP + 11)])
    expect(afterLive.items).toHaveLength(BACKSTOP + 11)
    expect(afterLive.items[0]?.sequence).toBe(1)
  })

  it("keeps a paged-in run of a subagent's rows at the head until an own row pushes it out", () => {
    // A full window of own rows, then a page back that holds only a subagent's rows.
    const hydrated = hydrate(range(2_000, CAP).map(item), true)
    const older = reduceStructuredAgentSession(hydrated, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch-a', sequence: 2_000 },
      page: page(range(1_800, 200).map(childItem), true)
    })
    expect(older.items[0]?.sequence).toBe(1_800)

    const afterChild = streamBatches(older, [childItem(3_100)])
    expect(afterChild.items[0]?.sequence).toBe(1_800)

    const afterOwn = streamBatches(afterChild, [item(3_101)])
    expect(afterOwn.items[0]?.sequence).toBe(2_001)
  })

  it('trims a transcript with no subagent rows to its newest rows, exactly as before', () => {
    const hydrated = hydrate(range(0, 300).map(item), true)
    const streamed = streamBatches(hydrated, range(300, CAP + 77).map(item), 97)
    const older = reduceStructuredAgentSession(streamed, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch-a', sequence: streamed.items[0]?.sequence ?? 0 },
      page: page(range((streamed.items[0]?.sequence ?? 0) - 200, 200).map(item), true)
    })
    const afterLive = streamBatches(older, range(CAP + 377, 5).map(item))

    const newest = (from: number, length: number) => range(from, length)
    expect(streamed.items.map(({ sequence }) => sequence)).toEqual(newest(377, CAP))
    expect(older.items.map(({ sequence }) => sequence)).toEqual(newest(177, CAP + 200))
    expect(afterLive.items.map(({ sequence }) => sequence)).toEqual(newest(182, CAP + 200))
  })
})
