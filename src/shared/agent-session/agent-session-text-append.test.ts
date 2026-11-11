import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import {
  type AgentSessionTextAppendItem,
  createAgentSessionTextAppendReader,
  sendingTextAppends
} from './agent-session-text-append'

function reply(text: string, revision: number): AgentJournalRenderItem {
  return {
    itemId: 'reply-1',
    revision,
    sequence: 4,
    observedAt: 1000,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function appended(revision: number, from: number, text: string): AgentSessionTextAppendItem {
  return { ...reply('', revision), textAppend: { from, text } }
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

describe('agent session text appends', () => {
  it('sends a growing reply whole once, then only its new text until a snapshot', () => {
    const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
    send(snapshot)
    expect(sentItems(send(batch(4, [reply('Hel', 1)])))).toEqual([reply('Hel', 1)])
    expect(sentItems(send(batch(5, [reply('Hello wor', 2)])))).toEqual([appended(2, 3, 'lo wor')])
    // A catch-up snapshot replaces what the reader holds, so the reply goes whole again.
    send(snapshot)
    expect(sentItems(send(batch(6, [reply('Hello world', 3)])))).toEqual([reply('Hello world', 3)])
  })

  it('restores the whole reply from an append', () => {
    const read = createAgentSessionTextAppendReader({})
    read(snapshot)
    read(batch(4, [reply('Hel', 1)]))
    expect(sentItems(read(batch(5, [appended(2, 3, 'lo wor')])) ?? batch(5, []))).toEqual([
      reply('Hello wor', 2)
    ])
  })

  it('sends a running tool output head as its new text only to streams that asked', () => {
    const tool = (
      head: string,
      revision: number,
      state: 'running' | 'completed' = 'running',
      byteLength = head.length
    ) =>
      ({
        itemId: 'tool-1',
        revision,
        sequence: 4,
        observedAt: 1000,
        body: {
          kind: 'tool-call',
          name: 'Bash',
          input: { command: 'make' },
          state,
          output: { head, byteLength, digest: `d${revision}`, truncated: false }
        }
      }) satisfies AgentJournalRenderItem
    const sentAppend = { ...tool('', 2, 'running', 11), textAppend: { from: 4, text: 'ding\nok' } }
    const legacy = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {})
    legacy(snapshot)
    legacy(batch(4, [tool('build', 1)]))
    expect(sentItems(legacy(batch(5, [tool('building\nok', 2)])))).toEqual([
      tool('building\nok', 2)
    ])

    const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => event, {
      toolOutputAppend: 1
    })
    const read = createAgentSessionTextAppendReader({ toolOutputAppend: 1 })
    send(snapshot)
    read(snapshot)
    read(send(batch(4, [tool('buil', 1)])))
    const sent = send(batch(5, [tool('building\nok', 2)]))
    expect(sentItems(sent)).toEqual([sentAppend])
    expect(sentItems(read(sent) ?? batch(5, []))).toEqual([tool('building\nok', 2)])
    // A finished call is no base, so its next revision goes whole.
    read(send(batch(6, [tool('building\nok\ndone', 3, 'completed')])))
    expect(sentItems(send(batch(7, [tool('building\nok\ndone!', 4, 'completed')])))).toEqual([
      tool('building\nok\ndone!', 4, 'completed')
    ])
  })
})
