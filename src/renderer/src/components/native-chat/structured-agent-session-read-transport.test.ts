import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSession: mocks.subscribe
}))

import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'

type SubscribeAttempt = {
  closed: PromiseWithResolvers<{ unsubscribe: () => void }>
  onClose: () => void
  onError: (error: unknown) => void
  onEvent: (event: AgentSessionSubscribeEvent) => void
  unsubscribe: ReturnType<typeof vi.fn<() => void>>
}

const target = { kind: 'local' } as const

function snapshot(sequence: number): AgentSessionSubscribeEvent {
  const cursor: AgentJournalCursor = { epoch: 'epoch-a', sequence }
  const page: AgentSessionHistoryPage = {
    sessionId: 'session-a',
    epoch: cursor.epoch,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false
  }
  return { type: 'snapshot', sessionId: 'session-a', page, fence: sequence }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('structured agent-session read transport generations', () => {
  const attempts: SubscribeAttempt[] = []

  beforeEach(() => {
    attempts.length = 0
    vi.clearAllMocks()
    mocks.subscribe.mockImplementation((_target, _params, onEvent, onError, onClose) => {
      const attempt: SubscribeAttempt = {
        closed: Promise.withResolvers<{ unsubscribe: () => void }>(),
        onClose,
        onError,
        onEvent,
        unsubscribe: vi.fn<() => void>()
      }
      attempts.push(attempt)
      return attempt.closed.promise
    })
  })

  function start(applyEvent: (event: AgentSessionSubscribeEvent) => void, applyError = vi.fn()) {
    return startStructuredAgentSessionReadTransport({
      applyEvent,
      applyError,
      getCursor: () => null,
      onHistoryReadInvalidated: () => undefined,
      refreshTail: async () => undefined,
      sessionId: 'session-a',
      target
    })
  }

  it('ignores opening frames after disposal and a replacement transport starts', async () => {
    const applyEvent = vi.fn()
    const applyError = vi.fn()
    const retired = start(applyEvent, applyError)
    await flushPromises()
    expect(attempts).toHaveLength(1)

    retired.dispose()
    const replacement = start(applyEvent, applyError)
    await flushPromises()
    expect(attempts).toHaveLength(2)

    attempts[0].onEvent(snapshot(1))
    attempts[0].onError(new Error('retired error'))
    attempts[0].onClose()
    expect(applyEvent).not.toHaveBeenCalled()
    expect(applyError).not.toHaveBeenCalled()

    attempts[0].closed.resolve({ unsubscribe: attempts[0].unsubscribe })
    attempts[1].closed.resolve({ unsubscribe: attempts[1].unsubscribe })
    await flushPromises()
    expect(attempts[0].unsubscribe).toHaveBeenCalledOnce()

    attempts[1].onEvent(snapshot(2))
    expect(applyEvent).toHaveBeenCalledExactlyOnceWith(snapshot(2))
    replacement.dispose()
  })

  it('ignores callbacks from a subscription superseded by reconnect', async () => {
    vi.useFakeTimers()
    try {
      const applyEvent = vi.fn()
      const applyError = vi.fn()
      const transport = start(applyEvent, applyError)
      await flushPromises()
      attempts[0].closed.resolve({ unsubscribe: attempts[0].unsubscribe })
      await flushPromises()

      attempts[0].onClose()
      await vi.advanceTimersByTimeAsync(750)
      expect(attempts).toHaveLength(2)

      attempts[0].onEvent(snapshot(1))
      attempts[0].onError(new Error('stale error'))
      expect(applyEvent).not.toHaveBeenCalled()
      expect(applyError).not.toHaveBeenCalled()

      attempts[1].onEvent(snapshot(2))
      expect(applyEvent).toHaveBeenCalledExactlyOnceWith(snapshot(2))
      attempts[1].closed.resolve({ unsubscribe: attempts[1].unsubscribe })
      await flushPromises()
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
