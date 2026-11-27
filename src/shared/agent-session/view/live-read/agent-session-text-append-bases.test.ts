import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { createAgentSessionTextAppendReader, sendingTextAppends } from './agent-session-text-append'

function reply(text: string, revision: number, turn = 'turn-1'): AgentJournalRenderItem {
  return {
    itemId: `reply-${turn}`,
    revision,
    sequence: 4,
    observedAt: 1000,
    turnScope: { kind: 'turn', turnItemId: turn },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function turnRow(itemId: string, revision: number): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: 3,
    observedAt: 1000,
    turnScope: { kind: 'thread' },
    body: { kind: 'turn', turnId: itemId, state: 'completed' }
  }
}

function batch(sequence: number, items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: { cursor: { epoch: 'epoch-1', sequence }, items, removedItemIds: [], submissions: [] }
  }
}

const snapshot: AgentSessionSubscribeEvent = {
  type: 'snapshot',
  sessionId: 'session-1',
  fence: 1,
  page: {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    direction: 'before',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 3 } },
    hasOlder: false,
    hasNewer: false
  }
}

function sentItems(event: AgentSessionSubscribeEvent): unknown[] {
  return event.type === 'batch' ? event.batch.items : []
}

it('holds no base from a page whose turns have all ended', () => {
  const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
  if (snapshot.type !== 'snapshot') {
    throw new Error('fixture is a snapshot')
  }
  send({ ...snapshot, page: { ...snapshot.page, items: [reply('A finished reply', 1)] } })
  expect(send.holdsBase('reply-turn-1')).toBeNull()
  // A turn still running off the page keeps its reply's base.
  send({
    ...snapshot,
    page: {
      ...snapshot.page,
      items: [reply('A growing reply', 1)],
      latestTurn: {
        itemId: 'turn-1',
        observedAt: 1,
        turn: { turnId: 't1', state: 'running' }
      }
    }
  })
  expect(send.holdsBase('reply-turn-1')).toBe(true)
})

it('lets go of its bases once a turn ends, sending the next reply text whole', () => {
  const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
  const read = createAgentSessionTextAppendReader({})
  const turnEnd = turnRow('turn-1', 2)
  for (const event of [snapshot, batch(4, [reply('Hel', 1)]), batch(5, [turnEnd])]) {
    read(send(event))
  }
  expect(send.holdsBase('reply-turn-1')).toBeNull()
  const next = send(batch(6, [reply('Hello', 2)]))
  expect(sentItems(next)).toEqual([reply('Hello', 2)])
  // The reader, which still holds its base, takes the whole row.
  expect(sentItems(read(next)!)).toEqual([reply('Hello', 2)])
})

it("keeps a running reply's base when an older turn's row is revised", () => {
  const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
  send(snapshot)
  send(batch(4, [reply('The new turn so far', 1, 'turn-2')]))
  // A context report revises the finished turn after the next one has started streaming.
  send(batch(5, [turnRow('turn-1', 3)]))
  expect(send.holdsBase('reply-turn-2')).toBe(true)
  send(batch(6, [turnRow('turn-2', 2)]))
  expect(send.holdsBase('reply-turn-2')).toBeNull()
})

it('evicts as its reader does, so a row outliving many finished turns still reads', () => {
  const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
  const read = createAgentSessionTextAppendReader({})
  const ongoing = (text: string, revision: number): AgentJournalRenderItem => ({
    ...reply(text, revision, 'ongoing'),
    turnScope: { kind: 'thread' }
  })
  let sequence = 4
  const roundTrip = (items: AgentJournalRenderItem[]) => read(send(batch(sequence++, items)))
  read(send(snapshot))
  roundTrip([ongoing('Still', 1)])
  // More finished replies than either end keeps bases for.
  for (let turn = 1; turn <= 12; turn++) {
    roundTrip([reply('A reply', 1, `turn-${turn}`)])
    roundTrip([turnRow(`turn-${turn}`, 2)])
  }
  expect(sentItems(roundTrip([ongoing('Still going', 2)])!)).toEqual([ongoing('Still going', 2)])
})
