import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { createAgentSessionTextAppendReader, sendingTextAppends } from './agent-session-text-append'

function reply(text: string, revision: number): AgentJournalRenderItem {
  return {
    itemId: 'reply-1',
    revision,
    sequence: 4,
    observedAt: 1000,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
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
  expect(send.holdsBase('reply-1')).toBe(false)
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
  expect(send.holdsBase('reply-1')).toBe(true)
})

it('lets go of its bases once a turn ends, sending the next reply text whole', () => {
  const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
  const read = createAgentSessionTextAppendReader({})
  const turnEnd: AgentJournalRenderItem = {
    itemId: 'turn-1',
    revision: 2,
    sequence: 3,
    observedAt: 1000,
    body: { kind: 'turn', turnId: 't1', state: 'completed' }
  }
  for (const event of [snapshot, batch(4, [reply('Hel', 1)]), batch(5, [turnEnd])]) {
    read(send(event))
  }
  expect(send.holdsBase('reply-1')).toBe(false)
  const next = send(batch(6, [reply('Hello', 2)]))
  expect(sentItems(next)).toEqual([reply('Hello', 2)])
  // The reader, which still holds its base, takes the whole row.
  expect(sentItems(read(next)!)).toEqual([reply('Hello', 2)])
})
