import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { startStructuredAgentSessionLiveRead } from './structured-agent-session-live-read'

function batch(sequence: number, items: unknown[] = []): AgentSessionSubscribeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    type: 'batch',
    sessionId: 's',
    batch: { cursor: { epoch: 'e', sequence }, items, removedItemIds: [], submissions: [] }
  } as AgentSessionSubscribeEvent
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve()
  }
}

describe('live read credit hooks', () => {
  it('advances, seeds, observes before coalescing, and loses inside a failed append decode', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const streams: ((event: AgentSessionSubscribeEvent) => void)[] = []
      const read = startStructuredAgentSessionLiveRead({
        applyEvent: (event) => calls.push(`apply:${event.type}`),
        applyError: () => {},
        getCursor: () => ({ epoch: 'e', sequence: 3 }),
        onContactLost: () => calls.push('contact-lost'),
        onHistoryReadInvalidated: () => {},
        sessionId: 's',
        subscribe: async (_params, onEvent) => {
          streams.push(onEvent)
          return { unsubscribe: () => {} }
        },
        textAppend: Promise.resolve({ textAppend: 1 }),
        readCurrentRequests: async () => {
          throw new Error('unused')
        },
        subscribeRetryNow: () => () => {},
        credit: {
          openGenerationAdvanced: (generation) => calls.push(`advance:${generation}`),
          subscribeCursor: (generation, cursor) =>
            calls.push(`cursor:${generation}:${cursor?.sequence}`),
          observeFrame: (event, generation) => calls.push(`observe:${generation}:${event.type}`)
        }
      })
      // The advance happens before the open's first await.
      expect(calls).toEqual(['advance:1'])
      await settle()
      expect(calls).toEqual(['advance:1', 'cursor:1:3'])
      streams[0]!(batch(3))
      expect(calls.slice(2)).toEqual(['observe:1:batch', 'apply:batch'])
      calls.length = 0
      // An ordinary frame is seen by the latch now, while the reducer waits for the coalescer.
      streams[0]!(batch(4))
      expect(calls).toEqual(['observe:1:batch'])
      calls.length = 0
      // A malformed append replaces the connected stream: the next open advances synchronously,
      // inside this same delivery, before any later frame.
      streams[0]!(batch(5, [{ itemId: 'x', textAppend: 'not an append' }]))
      expect(calls).toContain('advance:2')
      expect(calls).not.toContain('observe:1:batch')
      read.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
