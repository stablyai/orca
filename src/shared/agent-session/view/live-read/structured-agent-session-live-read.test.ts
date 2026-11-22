import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
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

function batch(sequence: number, items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: { cursor: { epoch: 'epoch-1', sequence }, items, removedItemIds: [], submissions: [] }
  }
}

describe('structured agent session live read', () => {
  it('reconnects when the subscription emits end before opening resolves', async () => {
    vi.useFakeTimers()
    try {
      const opened: { emit: (event: AgentSessionSubscribeEvent) => void }[] = []
      const unsubscribed: number[] = []
      const onContactLost = vi.fn()
      const subscribe: StructuredAgentSessionLiveSubscribe = async (_params, onEvent) => {
        const index = opened.push({ emit: onEvent }) - 1
        if (index === 0) {
          onEvent({ type: 'end' })
          // A trailing frame on the ended stream before subscribe resolves must be ignored.
          onEvent(batch(5, [reply('Stale', 2)]))
        } else {
          onEvent(batch(5, [reply('Reconnected', 2)]))
        }
        return { unsubscribe: () => unsubscribed.push(index) }
      }
      const applied: AgentSessionSubscribeEvent[] = []
      const read = startStructuredAgentSessionLiveRead({
        applyEvent: (event) => applied.push(event),
        applyError: () => {},
        getCursor: () => ({ epoch: 'epoch-1', sequence: 4 }),
        onContactLost,
        onHistoryReadInvalidated: () => {},
        sessionId: 'session-1',
        subscribe,
        readCurrentRequests: vi.fn(),
        subscribeRetryNow: () => () => {}
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(opened).toHaveLength(1)
      expect(unsubscribed).toEqual([0])
      expect(onContactLost).toHaveBeenCalledTimes(1)
      expect(applied).toEqual([{ type: 'end' }])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(opened).toHaveLength(2)
      expect(applied).toEqual([{ type: 'end' }, batch(5, [reply('Reconnected', 2)])])
      read.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
