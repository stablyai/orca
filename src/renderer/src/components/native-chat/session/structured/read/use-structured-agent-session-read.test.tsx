// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../../../../shared/agent-session/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('../../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock(
  '../../../../../runtime/native-chat/requests/structured-agent-session-subscriptions',
  () => ({
    subscribeStructuredAgentSession: mocks.subscribe
  })
)

import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import {
  findStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner-registry'

import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../../../../../shared/agent-session/structured-agent-session-coalescer'
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

  it('keeps a row removed when its upsert and removal arrive within one streaming window', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, page: page('tail', [], false) })
    const { result, unmount } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    const emit: (event: AgentSessionSubscribeEvent) => void = mocks.subscribe.mock.calls[0][2]
    act(() =>
      emit({ type: 'snapshot', sessionId: 'session-a', page: page('tail', [], false), fence: 1 })
    )
    vi.useFakeTimers()
    try {
      const batch = {
        cursor: { epoch: 'epoch-a', sequence: 501 },
        items: [message('answer', 501, 'assistant')],
        removedItemIds: [],
        submissions: []
      }
      act(() => emit({ type: 'batch', sessionId: 'session-a', batch }))
      act(() =>
        emit({
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            ...batch,
            cursor: { epoch: 'epoch-a', sequence: 502 },
            items: [],
            removedItemIds: ['answer']
          }
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      })
      expect(result.current.state.items).toEqual([])
      expect(result.current.state.cursor?.sequence).toBe(502)
    } finally {
      unmount()
      vi.useRealTimers()
    }
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

  it('releases browsed history only after the last reader returns and retires its old page', async () => {
    const corpus = Array.from({ length: 4000 }, (_, index) =>
      message(`row-${index + 1}`, index + 1, 'assistant')
    )
    mocks.call.mockImplementation(
      async (_target, _method, params: { direction: string; cursor?: AgentJournalCursor }) => {
        const end = params.cursor ? params.cursor.sequence - 1 : 4000
        const items = corpus.slice(Math.max(0, end - 200), end)
        return {
          ok: true,
          page: {
            ...page(params.direction === 'tail' ? 'tail' : 'before', items, true),
            liveCursor: { epoch: 'epoch-a', sequence: 4000 }
          }
        }
      }
    )
    const view = renderHook(
      ({ secondVisible }) => ({
        first: useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET }),
        second: useStructuredAgentSessionRead({
          sessionId: 'session-a',
          target: LOCAL_TARGET,
          isVisible: secondVisible
        })
      }),
      { initialProps: { secondVisible: true } }
    )
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    const releaseFirst = view.result.current.first.retainHistory()
    const releaseSecond = view.result.current.second.retainHistory()
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      await act(async () => {
        await view.result.current.first.loadOlder()
      })
    }
    expect(view.result.current.first.state.items).toHaveLength(2000)
    // Selection alone must not retire the source's initial autofill.
    const releaseSelection = view.result.current.first.retainHistory()
    act(() => releaseSelection())
    expect(view.result.current.first.state.items).toHaveLength(2000)
    expect(view.result.current.first.initialHistoryAutoLoad).toBe(true)
    view.rerender({ secondVisible: false })
    act(() => {
      releaseFirst()
      view.result.current.first.trimHistory()
    })
    expect(view.result.current.first.state.items).toHaveLength(2000)
    const oldPage = Promise.withResolvers<{ ok: true; page: AgentSessionHistoryPage }>()
    mocks.call.mockImplementationOnce(() => oldPage.promise)
    let oldRead!: Promise<string>
    act(() => {
      oldRead = view.result.current.second.loadOlder()
    })
    act(() => releaseSecond())
    expect(view.result.current.first.state.items).toHaveLength(1024)
    expect(view.result.current.first.state.items[0]?.sequence).toBe(2977)
    expect(view.result.current.first.state.cursor).toEqual({ epoch: 'epoch-a', sequence: 4000 })
    expect(view.result.current.first.state.hasOlder).toBe(true)
    expect(view.result.current.first.loadingOlder).toBe(false)
    const releaseAgain = view.result.current.first.retainHistory()
    const newPage = Promise.withResolvers<{ ok: true; page: AgentSessionHistoryPage }>()
    mocks.call.mockImplementationOnce(() => newPage.promise)
    let newRead!: Promise<string>
    act(() => {
      newRead = view.result.current.first.loadOlder()
    })
    await act(async () => {
      oldPage.resolve({ ok: true, page: page('before', corpus.slice(1800, 2000), true) })
      await expect(oldRead).resolves.toBe('superseded')
    })
    expect(view.result.current.first.state.items[0]?.sequence).toBe(2977)
    expect(view.result.current.first.loadingOlder).toBe(true)
    await act(async () => {
      newPage.resolve({ ok: true, page: page('before', corpus.slice(2776, 2976), true) })
      await expect(newRead).resolves.toBe('applied')
    })
    expect(view.result.current.first.state.items[0]?.sequence).toBe(2777)
    act(() => releaseAgain())
    expect(view.result.current.first.state.items[0]?.sequence).toBe(2977)
    view.unmount()
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
      cursor: { epoch: 'epoch-a', sequence: 500 }
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
})

// Keep loaded chats, including empty ones, through transport blips; show explicit host refusals or initial-load failures.
describe('useStructuredAgentSessionRead stream failures', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
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
})
