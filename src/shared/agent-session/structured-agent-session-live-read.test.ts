import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import type { AgentSessionTextAppendItem } from './agent-session-text-append'
import {
  startStructuredAgentSessionLiveRead,
  type StructuredAgentSessionLiveSubscribe
} from './structured-agent-session-live-read'

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

describe('structured agent session live read with text appends', () => {
  it('drops a stream whose append does not match and resumes without appends', async () => {
    const opened: { params: unknown; emit: (event: AgentSessionSubscribeEvent) => void }[] = []
    const unsubscribed: number[] = []
    const subscribe: StructuredAgentSessionLiveSubscribe = async (params, onEvent) => {
      const index = opened.push({ params, emit: onEvent }) - 1
      return { unsubscribe: () => unsubscribed.push(index) }
    }
    const applied: AgentSessionSubscribeEvent[] = []
    const read = startStructuredAgentSessionLiveRead({
      applyEvent: (event) => applied.push(event),
      applyError: () => {},
      getCursor: () => ({ epoch: 'epoch-1', sequence: 4 }),
      onContactLost: () => {},
      onHistoryReadInvalidated: () => {},
      sessionId: 'session-1',
      subscribe,
      textAppend: Promise.resolve({ textAppend: 1 }),
      readCurrentRequests: vi.fn(),
      subscribeRetryNow: () => () => {}
    })
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0]?.params).toEqual({
      sessionId: 'session-1',
      cursor: { epoch: 'epoch-1', sequence: 4 },
      capabilities: { textAppend: 1 }
    })
    opened[0]?.emit(batch(4, [reply('Hel', 1)]))
    opened[0]?.emit(batch(5, [appended(2, 7, 'lo')]))

    await vi.waitFor(() => expect(opened).toHaveLength(2))
    expect(opened[1]?.params).toEqual({
      sessionId: 'session-1',
      cursor: { epoch: 'epoch-1', sequence: 4 }
    })
    expect(unsubscribed).toEqual([0])
    expect(applied).toEqual([batch(4, [reply('Hel', 1)])])
    read.dispose()
  })
})
