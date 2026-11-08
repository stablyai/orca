import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTextAppendItem } from '../../../../../../../shared/agent-session/agent-session-text-append'
import type { AgentSessionCurrentRequestsMarker } from '../../../../../../../shared/agent-session/requests/agent-session-current-requests-wire'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../../../../shared/agent-session/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  watchHostContact: vi.fn(),
  supports: vi.fn()
}))

vi.mock('../../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock(
  '../../../../../runtime/native-chat/requests/structured-agent-session-subscriptions',
  () => ({
    subscribeStructuredAgentSession: mocks.subscribe
  })
)

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapabilities: mocks.supports
}))

vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: mocks.watchHostContact
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

function snapshot(
  sequence: number,
  currentRequests?: AgentSessionCurrentRequestsMarker
): AgentSessionSubscribeEvent {
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
  return {
    type: 'snapshot',
    sessionId: 'session-a',
    page,
    fence: sequence,
    ...(currentRequests ? { currentRequests } : {})
  }
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

  function start(
    applyEvent: Parameters<typeof startStructuredAgentSessionReadTransport>[0]['applyEvent'],
    applyError = vi.fn(),
    applyRequests = vi.fn()
  ) {
    return startStructuredAgentSessionReadTransport({
      subscribeRetryNow: () => () => {},
      applyRequests,
      applyEvent,
      applyError,
      getCursor: () => null,
      onContactLost: vi.fn(),
      onHistoryReadInvalidated: () => undefined,
      hydrate: async () => undefined,
      sessionId: 'session-a',
      target
    })
  }

  it('asks a remote host for every append it advertises and rebuilds appended replies', async () => {
    mocks.supports.mockResolvedValue([true, true])
    const applied: AgentSessionSubscribeEvent[] = []
    const transport = startStructuredAgentSessionReadTransport({
      subscribeRetryNow: () => () => {},
      applyEvent: (event) => applied.push(event),
      applyError: vi.fn(),
      getCursor: () => null,
      onContactLost: vi.fn(),
      onHistoryReadInvalidated: () => undefined,
      sessionId: 'session-a',
      target: { kind: 'environment', environmentId: 'env-a' }
    })
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    expect(mocks.subscribe.mock.calls[0]?.[1]).toEqual({
      sessionId: 'session-a',
      capabilities: { textAppend: 1, toolOutputAppend: 1 }
    })
    const reply = (text: string, revision: number): AgentJournalRenderItem => ({
      itemId: 'reply-a',
      revision,
      sequence: 101,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
    })
    const batch = (sequence: number, item: AgentJournalRenderItem): AgentSessionSubscribeEvent => ({
      type: 'batch',
      sessionId: 'session-a',
      batch: {
        cursor: { epoch: 'epoch-a', sequence },
        items: [item],
        removedItemIds: [],
        submissions: []
      }
    })
    attempts[0].onEvent(snapshot(100))
    attempts[0].onEvent(batch(101, reply('Hel', 1)))
    const appended: AgentSessionTextAppendItem = {
      ...reply('', 2),
      textAppend: { from: 3, text: 'lo' }
    }
    attempts[0].onEvent(batch(102, appended))
    await vi.waitFor(() => expect(applied.at(-1)).toEqual(batch(102, reply('Hello', 2))))
    transport.dispose()
  })

  it('flushes queued rows before reading the applied cursor for reconnect', async () => {
    vi.useFakeTimers()
    try {
      let state = EMPTY_STRUCTURED_AGENT_SESSION
      const transport = startStructuredAgentSessionReadTransport({
        subscribeRetryNow: () => () => {},
        applyEvent: (event) => {
          state = reduceStructuredAgentSession(state, { type: 'event', event })
        },
        applyError: vi.fn(),
        getCursor: () => state.cursor,
        onContactLost: vi.fn(),
        onHistoryReadInvalidated: () => undefined,
        sessionId: 'session-a',
        target
      })
      attempts[0].onEvent(snapshot(100))
      attempts[0].closed.resolve({ unsubscribe: attempts[0].unsubscribe })
      await flushPromises()
      attempts[0].onClose()
      await vi.advanceTimersByTimeAsync(720)
      attempts[0].onEvent({
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 101 },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      })
      expect(state.cursor?.sequence).toBe(100)
      await vi.advanceTimersByTimeAsync(30)
      expect(state.cursor?.sequence).toBe(101)
      expect(mocks.subscribe.mock.calls[1]?.[1]).toEqual({
        sessionId: 'session-a',
        cursor: { epoch: 'epoch-a', sequence: 101 }
      })
      attempts[1].closed.resolve({ unsubscribe: attempts[1].unsubscribe })
      await flushPromises()
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies each subscription's first batch alone and marked, and coalesces the rest", async () => {
    vi.useFakeTimers()
    try {
      const applied: [number | undefined, boolean][] = []
      const batch = (sequence: number): AgentSessionSubscribeEvent => ({
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      })
      const transport = start((event, options) => {
        applied.push([
          event.type === 'batch' ? event.batch.cursor.sequence : undefined,
          options?.opensSubscription === true
        ])
      })
      await flushPromises()
      attempts[0].onEvent(batch(1))
      attempts[0].onEvent(batch(2))
      attempts[0].onEvent(batch(3))
      expect(applied).toEqual([[1, true]])
      await vi.advanceTimersByTimeAsync(60)
      expect(applied).toEqual([
        [1, true],
        [3, false]
      ])

      attempts[0].closed.resolve({ unsubscribe: attempts[0].unsubscribe })
      await flushPromises()
      attempts[0].onClose()
      await vi.advanceTimersByTimeAsync(750)
      attempts[1].onEvent(batch(4))
      expect(applied.at(-1)).toEqual([4, true])
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Ownership may briefly be unattached during hold acquisition or workspace teardown; suppress transient close-time errors.
const UNATTACHED = 'agent_session_ownership_unknown'

describe('structured agent-session read transport unattached refusals', () => {
  const attempts: SubscribeAttempt[] = []

  beforeEach(() => {
    attempts.length = 0
    vi.clearAllMocks()
    mocks.supports.mockResolvedValue([false, false])
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

  function startWithHydration(
    hydrate: () => Promise<void>,
    applyError: (message: string) => void,
    applyEvent = vi.fn()
  ) {
    return startStructuredAgentSessionReadTransport({
      subscribeRetryNow: () => () => {},
      applyEvent,
      applyError,
      getCursor: () => null,
      onContactLost: vi.fn(),
      onHistoryReadInvalidated: () => undefined,
      hydrate,
      sessionId: 'session-a',
      target
    })
  }

  function rpcRefusal(code: string): Error & { code: string } {
    const error = new Error(code) as Error & { code: string }
    error.name = 'RuntimeRpcCallError'
    error.code = code
    return error
  }

  it('surfaces an unattached refusal that outlives the grace window', async () => {
    vi.useFakeTimers()
    try {
      const applyError = vi.fn()
      const transport = startWithHydration(async () => {
        throw rpcRefusal(UNATTACHED)
      }, applyError)
      await flushPromises()
      expect(applyError).not.toHaveBeenCalled()

      // Keep suppressing repeated refusals inside the acquisition/teardown grace window.
      for (let elapsed = 0; elapsed < 4_500; elapsed += 750) {
        await vi.advanceTimersByTimeAsync(750)
        attempts.at(-1)?.onError(rpcRefusal(UNATTACHED))
      }
      expect(applyError).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(750)
      attempts.at(-1)?.onError(rpcRefusal(UNATTACHED))
      expect(applyError).toHaveBeenCalledWith(UNATTACHED)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['journalCorrupt', 'journalWrittenByNewerOrca'])(
    'hands the pane the refusal a read met, and stops reconnecting only past %s',
    async (final) => {
      vi.useFakeTimers()
      try {
        const journalRefusal = (reason: string) => ({
          code: 'runtime_error',
          message: 'agent_session_journal_unreadable',
          data: { refusal: { code: 'agent_session_journal_unreadable', details: { reason } } }
        })
        const applyError = vi.fn()
        const transport = startWithHydration(async () => undefined, applyError)
        await flushPromises()
        expect(attempts).toHaveLength(1)

        attempts[0].onError(journalRefusal('journalUnavailable'))
        attempts[0].closed.resolve({ unsubscribe: attempts[0].unsubscribe })
        await flushPromises()
        expect(applyError).toHaveBeenLastCalledWith('agent_session_journal_unreadable', {
          code: 'agent_session_journal_unreadable',
          details: { reason: 'journalUnavailable' }
        })
        await vi.advanceTimersByTimeAsync(750)
        expect(attempts).toHaveLength(2)

        // Final damage/newer-format reasons end retry even when their message matches transient failures.
        attempts[1].onError(journalRefusal(final))
        attempts[1].closed.resolve({ unsubscribe: attempts[1].unsubscribe })
        await flushPromises()
        expect(applyError).toHaveBeenLastCalledWith('agent_session_journal_unreadable', {
          code: 'agent_session_journal_unreadable',
          details: { reason: final }
        })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(attempts).toHaveLength(2)
        transport.dispose()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('reads again as soon as a remote host is reachable, not after the grown wait', async () => {
    vi.useFakeTimers()
    try {
      let hostContactRegained = (): void => {}
      const stopWatch = vi.fn()
      mocks.watchHostContact.mockImplementation((_environmentId, listener: () => void) => {
        hostContactRegained = listener
        return stopWatch
      })
      const unavailable = { code: 'runtime_unavailable', message: 'Remote runtime is unavailable.' }
      const transport = startStructuredAgentSessionReadTransport({
        applyEvent: vi.fn(),
        applyError: vi.fn(),
        getCursor: () => null,
        onContactLost: vi.fn(),
        onHistoryReadInvalidated: () => undefined,
        hydrate: async () => undefined,
        sessionId: 'session-a',
        target: { kind: 'environment', environmentId: 'env-a' },
        subscribeRetryNow: (retry) => mocks.watchHostContact('env-a', retry)
      })
      expect(mocks.watchHostContact).toHaveBeenCalledWith('env-a', expect.any(Function))
      await vi.advanceTimersByTimeAsync(0)
      const refuseLatest = async (): Promise<void> => {
        const attempt = attempts.at(-1)!
        attempt.closed.resolve({ unsubscribe: attempt.unsubscribe })
        await flushPromises()
        attempt.onError(unavailable)
      }
      // An outage long enough that the wait reaches its cap.
      for (const delay of [750, 1_500, 3_000, 6_000, 12_000, 24_000]) {
        await refuseLatest()
        await vi.advanceTimersByTimeAsync(delay)
      }
      await refuseLatest()
      const opened = attempts.length
      await vi.advanceTimersByTimeAsync(29_000)
      expect(attempts).toHaveLength(opened)

      hostContactRegained()
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toHaveLength(opened + 1)

      await refuseLatest()
      await vi.advanceTimersByTimeAsync(750)
      expect(attempts).toHaveLength(opened + 2)

      transport.dispose()
      expect(stopWatch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
