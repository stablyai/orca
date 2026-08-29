// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
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

import {
  useStructuredAgentSessionRead,
  useStructuredAgentSessionReadObservation
} from './use-structured-agent-session-read'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'

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

  it('refreshes only visible structured sessions when the app regains focus', async () => {
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

    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call).toHaveBeenLastCalledWith(LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-visible',
      direction: 'tail',
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    visible.unmount()
    hidden.unmount()
    hasFocus.mockRestore()
  })

  it('drops a delayed refresh after reconnect without mutating state or provider session', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const delayedRefresh = Promise.withResolvers<{
      ok: true
      page: AgentSessionHistoryPage
      providerSession: { key: 'session_id'; id: string }
    }>()
    const closes: (() => void)[] = []
    const initialProviderSession = { key: 'session_id', id: 'provider-initial' } as const
    mocks.call
      .mockResolvedValueOnce({
        ok: true,
        page: page('tail', [message('initial', 1, 'assistant')], false),
        providerSession: initialProviderSession
      })
      .mockReturnValueOnce(delayedRefresh.promise)
    mocks.subscribe.mockImplementation((_target, _params, _onEvent, _onError, onClose) => {
      closes.push(onClose)
      return Promise.resolve({ unsubscribe: vi.fn() })
    })

    const view = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )

    try {
      await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
      expect(view.result.current.state.items[0]?.itemId).toBe('initial')
      expect(view.result.current.providerSession).toBe(initialProviderSession)
      const stateBeforeRefresh = view.result.current.state

      act(() => window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))

      vi.useFakeTimers()
      act(() => closes[0]?.())
      await act(async () => vi.advanceTimersByTimeAsync(750))
      expect(mocks.subscribe).toHaveBeenCalledTimes(2)

      await act(async () => {
        delayedRefresh.resolve({
          ok: true,
          page: page('tail', [message('stale', 2, 'assistant')], false),
          providerSession: { key: 'session_id', id: 'provider-stale' }
        })
        await delayedRefresh.promise
        await Promise.resolve()
      })

      expect(view.result.current.state).toBe(stateBeforeRefresh)
      expect(view.result.current.state.items[0]?.itemId).toBe('initial')
      expect(view.result.current.providerSession).toBe(initialProviderSession)
    } finally {
      vi.useRealTimers()
      view.unmount()
      hasFocus.mockRestore()
    }
  })

  it.each(['snapshot', 'reset'] as const)(
    'drops a delayed refresh after a same-stream %s advances the epoch',
    async (eventType) => {
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      const delayedRefresh = Promise.withResolvers<{
        ok: true
        page: AgentSessionHistoryPage
        providerSession: { key: 'session_id'; id: string }
      }>()
      const onEvents: ((event: AgentSessionSubscribeEvent) => void)[] = []
      const initialProviderSession = { key: 'session_id', id: 'provider-initial' } as const
      mocks.call
        .mockResolvedValueOnce({
          ok: true,
          page: page('tail', [message('initial', 1, 'assistant')], false),
          providerSession: initialProviderSession
        })
        .mockReturnValueOnce(delayedRefresh.promise)
      mocks.subscribe.mockImplementation((_target, _params, onEvent) => {
        onEvents.push(onEvent)
        return Promise.resolve({ unsubscribe: vi.fn() })
      })

      const view = renderHook(() =>
        useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
      )

      try {
        await waitFor(() => expect(onEvents).toHaveLength(1))
        act(() => window.dispatchEvent(new Event('focus')))
        await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))

        const replacementPage = page(
          'tail',
          [message('new-epoch', 2, 'assistant')],
          false,
          'epoch-b'
        )
        const replacementEvent: AgentSessionSubscribeEvent =
          eventType === 'reset'
            ? {
                type: 'reset',
                sessionId: 'session-a',
                reset: 'epoch_changed',
                page: replacementPage,
                fence: 2
              }
            : { type: 'snapshot', sessionId: 'session-a', page: replacementPage, fence: 2 }
        act(() => onEvents[0]?.(replacementEvent))

        expect(view.result.current.state.epoch).toBe('epoch-b')
        expect(view.result.current.state.items[0]?.itemId).toBe('new-epoch')
        expect(view.result.current.providerSession).toBe(initialProviderSession)
        const stateAfterReplacement = view.result.current.state

        await act(async () => {
          delayedRefresh.resolve({
            ok: true,
            page: page('tail', [message('stale-refresh', 3, 'assistant')], false),
            providerSession: { key: 'session_id', id: 'provider-stale' }
          })
          await delayedRefresh.promise
          await Promise.resolve()
        })

        expect(view.result.current.state).toBe(stateAfterReplacement)
        expect(view.result.current.state.epoch).toBe('epoch-b')
        expect(view.result.current.state.items[0]?.itemId).toBe('new-epoch')
        expect(view.result.current.providerSession).toBe(initialProviderSession)
      } finally {
        view.unmount()
        hasFocus.mockRestore()
      }
    }
  )

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

  it('shares one subscriber when pane and projection observe the same visible session', async () => {
    const unsubscribe = vi.fn()
    mocks.call.mockResolvedValue({ ok: true, page: page('tail', [], false) })
    mocks.subscribe.mockResolvedValue({ unsubscribe })

    const view = renderHook(() => {
      const pane = useStructuredAgentSessionRead({
        sessionId: 'session-shared',
        target: LOCAL_TARGET,
        isVisible: true
      })
      const projection = useStructuredAgentSessionReadObservation({
        sessionId: 'session-shared',
        target: LOCAL_TARGET
      })
      return { pane, projection }
    })

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(view.result.current.pane.state).toBe(view.result.current.projection.state)

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('preserves cached state while switching away and refreshes once on re-entry', async () => {
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
    expect(mocks.call).toHaveBeenCalledTimes(3)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})
