// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalSubmission,
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
  type AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import { useAppStore } from '@/store'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'

import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../../shared/structured-agent-session-send-evidence'

import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../../shared/structured-agent-session-coalescer'
import type { StructuredAgentSessionAdmission } from './structured-agent-session-read-owner-contract'

const LOCAL_TARGET = { kind: 'local' } as const

function message(id: string, sequence: number, role: 'user' | 'assistant'): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role, blocks: [{ type: 'text', text: id }] }
  }
}

function providerFrame(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      text: id,
      providerFrame: {
        provider: 'codex',
        kind: 'notification:item/commandExecution/outputDelta',
        payload: { head: id, byteLength: id.length, digest: id, truncated: false }
      }
    }
  }
}

function page(
  direction: 'tail' | 'before',
  items: AgentJournalRenderItem[],
  hasOlder: boolean,
  epoch = 'epoch-a'
): AgentSessionHistoryPage {
  const cursor = (sequence: number): AgentJournalCursor => ({ epoch, sequence })
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? oldest
  return {
    sessionId: 'session-a',
    epoch,
    direction,
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: items.length > 0 ? cursor(oldest) : null,
      newest: items.length > 0 ? cursor(newest) : null,
      nextCursor: cursor(oldest)
    },
    liveCursor: cursor(500),
    hasOlder,
    hasNewer: direction === 'before'
  }
}

describe('useStructuredAgentSessionRead history window', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('restores a realistic 21-turn window across the wire-safe bridge-sized read', async () => {
    const items = Array.from({ length: 21 }, (_, turn) => [
      message(`user-${turn}`, turn * 2 + 1, 'user'),
      message(`assistant-${turn}`, turn * 2 + 2, 'assistant')
    ]).flat()
    const olderItems = items.slice(0, 12)
    const tailItems = [
      ...Array.from({ length: 170 }, (_, index) => providerFrame(`delta-${index}`, 43 + index)),
      ...items.slice(12).map((item, index) => ({ ...item, sequence: 213 + index }))
    ]
    mocks.call
      .mockResolvedValueOnce({ ok: true, page: page('tail', tailItems, true) })
      .mockResolvedValueOnce({ ok: true, page: page('before', olderItems, false) })

    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )

    await waitFor(() =>
      expect(
        result.current.state.items.filter((item) => item.body.kind === 'message')
      ).toHaveLength(items.length)
    )
    expect(mocks.call).toHaveBeenNthCalledWith(1, LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'tail',
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    expect(mocks.call).toHaveBeenNthCalledWith(2, LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'before',
      cursor: { epoch: 'epoch-a', sequence: tailItems[0].sequence },
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
  })

  it('does not invent a writable fence for a mixed-version history page', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, page: page('tail', [], false) })

    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(result.current.state.fence).toBeNull()
  })

  it('loads each earlier page at the wire maximum', async () => {
    const tailItems = Array.from({ length: 200 }, (_, index) =>
      message(`tail-${index}`, 301 + index, 'assistant')
    )
    const initialOlderItems = Array.from({ length: 100 }, (_, index) =>
      message(`middle-${index}`, 201 + index, 'assistant')
    )
    mocks.call
      .mockResolvedValueOnce({
        ok: true,
        page: page('tail', tailItems, true)
      })
      .mockResolvedValueOnce({
        ok: true,
        page: page('before', initialOlderItems, true)
      })
      .mockResolvedValueOnce({
        ok: true,
        page: page('before', [message('oldest', 1, 'user')], false)
      })

    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.hasOlder).toBe(true))

    await act(async () => result.current.loadOlder())

    expect(mocks.call).toHaveBeenLastCalledWith(LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'before',
      cursor: { epoch: 'epoch-a', sequence: 201 },
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    expect(result.current.state.items).toHaveLength(301)
    expect(result.current.state.items[0]?.itemId).toBe('oldest')
  })

  it('shares one in-flight older page, and its result, with every caller', async () => {
    const tailItems = Array.from({ length: 300 }, (_, index) =>
      message(`tail-${index}`, 301 + index, 'assistant')
    )
    let deliver = (): void => {}
    mocks.call
      .mockResolvedValueOnce({ ok: true, page: page('tail', tailItems, true) })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = () =>
              resolve({ ok: true, page: page('before', [message('older', 1, 'user')], false) })
          })
      )
    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.hasOlder).toBe(true))

    let first!: Promise<string>
    let second!: Promise<string>
    act(() => {
      first = result.current.loadOlder()
    })
    expect(result.current.loadingOlder).toBe(true)
    act(() => {
      second = result.current.loadOlder()
    })
    expect(second).toBe(first)
    await act(async () => {
      deliver()
      await first
    })

    await expect(first).resolves.toBe('applied')
    await expect(second).resolves.toBe('applied')
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(result.current.loadingOlder).toBe(false)
    expect(result.current.state.items[0]?.itemId).toBe('older')
    await expect(result.current.loadOlder()).resolves.toBe('exhausted')
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it('reports an older page the host refused as failed, not applied', async () => {
    const tailItems = Array.from({ length: 300 }, (_, index) =>
      message(`tail-${index}`, 301 + index, 'assistant')
    )
    mocks.call
      .mockResolvedValueOnce({ ok: true, page: page('tail', tailItems, true) })
      .mockResolvedValueOnce({ ok: false, reset: 'expired', page: page('tail', [], true) })
    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.hasOlder).toBe(true))

    let outcome: Promise<string> = Promise.resolve('')
    await act(async () => {
      outcome = result.current.loadOlder()
      await outcome
    })
    await expect(outcome).resolves.toBe('failed')
    expect(result.current.loadingOlder).toBe(false)
  })

  it('does no host work when the app regains focus', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mocks.call.mockResolvedValue({ ok: true, page: page('tail', [], false) })
    const visible = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-visible',
        target: LOCAL_TARGET,
        isVisible: true
      })
    )
    const hidden = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-hidden',
        target: LOCAL_TARGET,
        isVisible: false
      })
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('focus')))

    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    visible.unmount()
    hidden.unmount()
    hasFocus.mockRestore()
  })

  it('does no host work for retained inactive sessions', async () => {
    const first = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-inactive-a',
        target: LOCAL_TARGET,
        isVisible: false
      })
    )
    const second = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-inactive-b',
        target: LOCAL_TARGET,
        isVisible: false
      })
    )

    await act(() => Promise.resolve())

    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    first.unmount()
    second.unmount()
  })

  it('preserves cached state and resumes at the applied cursor on re-entry', async () => {
    const unsubscribe = vi.fn()
    mocks.call.mockImplementation((_target, _method, params) => {
      const sessionId = (params as { sessionId: string }).sessionId
      return Promise.resolve({
        ok: true,
        page: {
          ...page('tail', [message(`${sessionId}-message`, 1, 'user')], false),
          sessionId
        }
      })
    })
    mocks.subscribe.mockResolvedValue({ unsubscribe })
    const view = renderHook(
      ({ active }: { active: 'first' | 'second' | null }) => ({
        first: useStructuredAgentSessionRead({
          sessionId: 'session-switch-a',
          target: LOCAL_TARGET,
          isVisible: active === 'first'
        }),
        second: useStructuredAgentSessionRead({
          sessionId: 'session-switch-b',
          target: LOCAL_TARGET,
          isVisible: active === 'second'
        })
      }),
      { initialProps: { active: null as 'first' | 'second' | null } }
    )
    expect(mocks.call).not.toHaveBeenCalled()

    view.rerender({ active: 'first' })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    expect(view.result.current.first.state.items[0]?.itemId).toBe('session-switch-a-message')

    view.rerender({ active: 'second' })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    view.rerender({ active: 'first' })
    expect(view.result.current.first.state.items[0]?.itemId).toBe('session-switch-a-message')
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(3))
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.subscribe.mock.calls[2]?.[1]).toEqual({
      sessionId: 'session-switch-a',
      cursor: view.result.current.first.state.cursor
    })
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    const owner = getStructuredAgentSessionReadOwner('session-switch-a', LOCAL_TARGET)
    act(() => owner.resync?.())
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(4))
    expect(unsubscribe).toHaveBeenCalledTimes(3)
    expect(mocks.call).toHaveBeenCalledTimes(2)
    view.unmount()
    owner.resync?.()
    expect(mocks.subscribe).toHaveBeenCalledTimes(4)
    expect(unsubscribe).toHaveBeenCalledTimes(4)
  })
})

describe('useStructuredAgentSessionRead currency', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
  })

  it('is current only once a run has been caught up with the host', async () => {
    const emits: ((event: AgentSessionSubscribeEvent) => void)[] = []
    mocks.call.mockResolvedValue({
      ok: true,
      page: page('tail', [message('m-1', 1, 'user')], false)
    })
    const closes: (() => void)[] = []
    mocks.subscribe.mockImplementation((_target, _params, onEvent, _onError, onClose) => {
      emits.push(onEvent)
      closes.push(onClose)
      return Promise.resolve({ unsubscribe: vi.fn() })
    })
    const frame = (sequence: number, hasNewer: boolean): AgentSessionSubscribeEvent => ({
      type: 'batch',
      sessionId: 'session-a',
      batch: {
        cursor: { epoch: 'epoch-a', sequence },
        items: [],
        removedItemIds: [],
        submissions: []
      },
      ...(hasNewer ? { hasNewer: true as const } : {})
    })
    const view = renderHook(
      ({ isVisible }: { isVisible: boolean }) =>
        useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET, isVisible }),
      { initialProps: { isVisible: true } }
    )
    await waitFor(() => expect(emits).toHaveLength(1))
    expect(view.result.current.readCurrent).toBe(false)

    // A resume with nothing missed is an empty frame that changes no state.
    act(() => emits[0]!(frame(view.result.current.state.cursor!.sequence, false)))
    expect(view.result.current.readCurrent).toBe(true)

    view.rerender({ isVisible: false })
    expect(view.result.current.readCurrent).toBe(false)

    view.rerender({ isVisible: true })
    await waitFor(() => expect(emits).toHaveLength(2))
    act(() => emits[1]!(frame(700, true)))
    expect(view.result.current.readCurrent).toBe(false)
    act(() => emits[1]!(frame(900, false)))
    await waitFor(() => expect(view.result.current.readCurrent).toBe(true))

    // A close makes retained state stale; a queued stream update must not mark it current afterward.
    act(() => {
      emits[1]!(frame(950, false))
      closes[1]!()
    })
    expect(view.result.current.readCurrent).toBe(false)
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(view.result.current.readCurrent).toBe(false)
  })
})

// Workspace deletion briefly leaves mounted chats with unknown ownership; an older-page failure must not replace the conversation the stream is retiring.
describe('useStructuredAgentSessionRead older page failures', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  function refusal(code: string): Error & { code: string } {
    const error = new Error(code) as Error & { code: string }
    error.name = 'RuntimeRpcCallError'
    error.code = code
    return error
  }

  const tailItems = Array.from({ length: 300 }, (_, index) =>
    message(`tail-${index}`, 301 + index, 'assistant')
  )

  async function loadedTailThatRefusesOlder(error: Error) {
    let outcome = ''
    mocks.call
      .mockResolvedValueOnce({ ok: true, page: page('tail', tailItems, true) })
      .mockRejectedValueOnce(error)
    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.hasOlder).toBe(true))
    await act(async () => {
      outcome = await result.current.loadOlder()
    })
    return { result, outcome }
  }

  it.each([
    ['a closed session', refusal('agent_session_ownership_unknown')],
    ['any other reason', new Error('journal read failed')]
  ])(
    'keeps the conversation and reports failed when an older page fails for %s',
    async (_case, error) => {
      const { result, outcome } = await loadedTailThatRefusesOlder(error)
      expect(outcome).toBe('failed')
      expect(result.current.state.status).not.toBe('error')
      expect(result.current.state.error).toBeUndefined()
      expect(result.current.state.items).toHaveLength(300)
      expect(result.current.loadingOlder).toBe(false)
    }
  )

  it('starts a new paging generation when the host re-sends its snapshot', async () => {
    const { result } = await loadedTailThatRefusesOlder(new Error('journal read failed'))
    const before = result.current.olderHistoryGeneration
    const onEvent = mocks.subscribe.mock.calls.at(-1)?.[2]
    act(() => {
      onEvent?.({
        type: 'snapshot',
        sessionId: 'session-a',
        page: page('tail', tailItems, true),
        fence: 0
      })
    })
    expect(result.current.olderHistoryGeneration).toBeGreaterThan(before)
  })
})

// Keep loaded chats, including empty ones, through transport blips; show explicit host refusals or initial-load failures.
describe('useStructuredAgentSessionRead stream failures', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  const journalRefusal = (details?: { reason: string }) => ({
    code: 'runtime_error',
    message: 'agent_session_journal_unreadable',
    data: {
      refusal: { code: 'agent_session_journal_unreadable', ...(details ? { details } : {}) }
    }
  })

  async function loadedChatWithNoMessages() {
    mocks.call.mockResolvedValueOnce({ ok: true, page: page('tail', [], false) })
    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    expect(result.current.state.status).toBe('ready')
    return { result, onError: mocks.subscribe.mock.calls[0]?.[3] }
  }

  it('leaves a loaded chat as it was when the connection drops', async () => {
    const { result, onError } = await loadedChatWithNoMessages()
    act(() => onError?.({ code: 'runtime_error', message: 'connection lost' }))
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state.error).toBeUndefined()
    expect(result.current.state.readRefusal).toBeUndefined()
  })

  // Unknown host refusal reasons are still authoritative answers.
  it.each([
    ['with its reason', { reason: 'journalUnavailable' }],
    ['without a reason', undefined]
  ])('still reports a refusal the host sent on a loaded chat, %s', async (_case, details) => {
    const { result, onError } = await loadedChatWithNoMessages()
    act(() => onError?.(journalRefusal(details)))
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.readRefusal).toEqual({
      code: 'agent_session_journal_unreadable',
      ...(details ? { details } : {})
    })
  })

  it('still reports a failure that names nothing before the chat first loads', async () => {
    mocks.call.mockRejectedValueOnce(new Error('journal read failed'))
    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.state.error).toBe('journal read failed')
    expect(result.current.state.epoch).toBeNull()
  })
  it('retains the action-only owner continuously across replacement and retirement', async () => {
    const owner = getStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)
    const a = Promise.withResolvers<void>()
    const first = vi.fn<(attempt: StructuredAgentSessionAdmission) => Promise<void>>(
      () => a.promise
    )
    const pending = owner.admit('A', () => true, first)
    const next = vi.fn<(attempt: StructuredAgentSessionAdmission) => Promise<void>>(
      () => new Promise<void>(() => {})
    )
    const successor = owner.admit('B', () => true, next)
    await pending
    expect(first.mock.calls[0][0].signal.aborted).toBe(true)
    expect(getStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)).toBe(owner)
    expect(owner.admit('B', () => true, next)).toBe(successor)
    a.resolve()
    await Promise.resolve()
    expect(next.mock.calls[0][0].current()).toBe(true)
    retireStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)
    await successor
    expect(next.mock.calls[0][0].current()).toBe(false)
    expect(findStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)).toBeUndefined()
  })
  it.each([100, 1000])(
    'reconciles %i rows only on relevant evidence, not activity frames',
    async (n) => {
      vi.useFakeTimers()
      const owner = getStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)
      let visits = 0
      const submissions: AgentJournalSubmission[] = Array.from({ length: n }, (_, i) => ({
        get reason() {
          visits += 1
          return null
        },
        clientMessageId: `old-${i}`,
        fence: 1,
        payloadFingerprint: 'send',
        dispatchState: 'accepted',
        providerItemId: null,
        submittedAt: i,
        resolvedAt: i
      }))
      const receipt = owner.trackSend('receipt')
      receipt.issue()
      owner.publishCreated({ ...page('tail', [], false), submissions })
      receipt.settle(false)
      expect(findStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)).toBe(owner)
      const stop = owner.activate({
        getState: useAppStore.getState,
        subscribeRetryNow: () => () => {}
      })
      const send = owner.trackSend('unknown')
      send.issue()
      send.settle(true)
      const emit: (event: AgentSessionSubscribeEvent) => void = mocks.subscribe.mock.calls[0][2]
      const batch = {
        cursor: { epoch: 'epoch-a', sequence: 501 },
        items: [],
        removedItemIds: [],
        submissions: []
      }
      expect(visits).toBeGreaterThanOrEqual(n)
      visits = 0
      for (let i = 0; i < 10; i += 1) {
        emit({
          type: 'batch',
          sessionId: 'session-a',
          batch,
          activity: { turnId: 't', text: `progress-${i}` }
        })
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      }
      expect(visits).toBe(0)
      expect(owner.getSnapshot().state.activity?.text).toBe('progress-9')
      const busy = (): boolean => {
        let result = false
        void owner.admit(
          'check',
          () => true,
          (attempt) => {
            result = attempt.busy()
          }
        )
        return result
      }
      const row = {
        ...submissions[0],
        clientMessageId: 'handoff',
        queuedMessageId: 'unknown',
        submittedAt: n,
        resolvedAt: n
      }
      for (const reason of [STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING, null]) {
        emit({
          type: 'batch',
          sessionId: 'session-a',
          batch: { ...batch, submissions: [{ ...row, reason }] }
        })
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        expect(busy()).toBe(reason !== null)
        await Promise.resolve()
      }
      owner.trackSend('handoff').issue()
      expect(busy()).toBe(false)
      await Promise.resolve()
      visits = 0
      emit({ type: 'batch', sessionId: 'session-a', batch })
      await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      expect(visits).toBe(0)
      stop()
      owner.dispose()
      emit({ type: 'batch', sessionId: 'session-a', batch })
      await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      expect(visits).toBe(0)
      vi.useRealTimers()
    }
  )
})
