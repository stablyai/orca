// @vitest-environment happy-dom
import * as Observation from './structured-attention-read-observation'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import {
  retainStructuredReadResume,
  takeStructuredReadResume,
  clearStructuredReadResumeCache
} from './structured-agent-session-read-resume-cache'
import type { StructuredAgentSessionReadSnapshot } from './structured-agent-session-read-owner-contract'

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

import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'

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

  it('collects its transport and resumes data and cursor together after a cold return', async () => {
    const items = Array.from({ length: 1000 }, (_, index) =>
      message(`deep-${index}`, index + 1, 'assistant')
    )
    mocks.call.mockResolvedValueOnce({ ok: true, page: page('tail', items, false) })
    const first = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(first.result.current.state.items).toHaveLength(1000))
    const cursor = first.result.current.state.cursor
    first.unmount()
    const calls = mocks.call.mock.calls.length
    const returned = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    expect(returned.result.current.state.items[99]?.itemId).toBe('deep-99')
    expect(returned.result.current.state.cursor).toEqual(cursor)
    expect(mocks.call).toHaveBeenCalledTimes(calls)
    expect(mocks.subscribe.mock.calls.at(-1)?.[1]).toMatchObject({ cursor })
  })

  it('projects compact attention once when collecting a reader, rather than on each publication', async () => {
    const projection = vi.spyOn(Observation, 'structuredAttentionReadObservation')
    mocks.call.mockResolvedValueOnce({
      ok: true,
      page: page('tail', [message('first', 1, 'assistant')], false)
    })
    const owner = getStructuredAgentSessionReadOwner('session-a', LOCAL_TARGET)
    const unsubscribe = owner.subscribe(vi.fn())
    const deactivate = owner.activate()
    await waitFor(() => expect(owner.getSnapshot().state.status).toBe('ready'))
    const onEvent = mocks.subscribe.mock.calls.at(-1)?.[2]
    for (let index = 0; index < 10; index++) {
      onEvent?.({
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          items: [message(`new-${index}`, index + 501, 'assistant')],
          removedItemIds: [],
          submissions: [],
          cursor: { epoch: 'epoch-a', sequence: index + 501 }
        }
      })
    }
    await waitFor(() => expect(owner.getSnapshot().state.items).toHaveLength(11))
    expect(projection).not.toHaveBeenCalled()
    deactivate()
    unsubscribe()
    expect(projection).toHaveBeenCalledOnce()
    projection.mockRestore()
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
    // A rail jump asking while scroll-to-top's page is in flight joins it.
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
    // History alone is not the host's present.
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

    // The stream closing under a pane that is showing: what it holds is stale until the reconnect,
    // and an update still waiting to be applied when it closed must not say otherwise.
    act(() => {
      emits[1]!(frame(950, false))
      closes[1]!()
    })
    expect(view.result.current.readCurrent).toBe(false)
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(view.result.current.readCurrent).toBe(false)
  })
})

// A workspace delete closes its structured chats while the pane is still mounted, so every read
// against that session refuses `agent_session_ownership_unknown` until the tab retires. A page that
// lost that race must not leave the pane holding an error the live transport is about to clear.
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

  // A failed older page is the list's to retry; it must never replace the loaded conversation.
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

// A loaded chat that loses contact is the transport's to retry: only a refusal the host sent, or a
// chat that never loaded, is owed the failure. A loaded chat with no messages yet would otherwise
// trade its empty state for the full-pane error on every blip.
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

  // A refusal whose reason this build doesn't know is still the host's answer, so it is owed too.
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
})

describe('inactive read data bounds', () => {
  afterEach(() => {
    clearStructuredReadResumeCache()
    vi.useRealTimers()
  })
  const snapshot = (error = ''): StructuredAgentSessionReadSnapshot => ({
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'cache-epoch',
      cursor: { epoch: 'cache-epoch', sequence: 17 },
      error
    },
    current: true,
    loadingOlder: true,
    olderHistoryGeneration: 0
  })
  it.each([100, 1000])(
    'counts cache traversal and UTF-8 encoding as input-sized work at %s items',
    (count) => {
      let itemReads = 0
      const data = snapshot()
      data.state.items = Array.from({ length: count }, (_, index) => ({
        ...message(`item-${index}`, index, 'assistant'),
        get revision() {
          itemReads++
          return 1
        }
      }))
      const encode = vi.spyOn(TextEncoder.prototype, 'encode')
      retainStructuredReadResume('counted', data)
      expect(takeStructuredReadResume('counted')?.state.items).toHaveLength(count)
      expect(itemReads).toBe(count)
      expect(encode.mock.calls.length).toBeGreaterThan(count)
      expect(encode.mock.calls.length).toBeLessThan(30 * count)
      expect(
        encode.mock.calls.reduce((total, args) => total + (args[0]?.length ?? 0), 0)
      ).toBeLessThan(400 * count)
      encode.mockRestore()
    }
  )

  it('transfers data with its cursor, expires from release, and bounds count, all fields and total bytes', () => {
    vi.useFakeTimers()
    retainStructuredReadResume('transfer', snapshot())
    expect(takeStructuredReadResume('transfer')).toMatchObject({
      current: false,
      loadingOlder: false,
      state: { cursor: { sequence: 17 } }
    })
    expect(takeStructuredReadResume('transfer')).toBeUndefined()
    for (let index = 0; index < 9; index++) {
      retainStructuredReadResume(`count-${index}`, snapshot())
    }
    expect(takeStructuredReadResume('count-0')).toBeUndefined()
    vi.advanceTimersByTime(300_001)
    expect(takeStructuredReadResume('count-8')).toBeUndefined()
    retainStructuredReadResume('oversize-field', snapshot('x'.repeat(8 * 1024 * 1024)))
    expect(takeStructuredReadResume('oversize-field')).toBeUndefined()
    const tooMany = snapshot()
    tooMany.state.items = Array.from({ length: 5001 }, () => message('item', 1, 'assistant'))
    retainStructuredReadResume('oversize-items', tooMany)
    expect(takeStructuredReadResume('oversize-items')).toBeUndefined()
    const large = snapshot('x'.repeat(6 * 1024 * 1024))
    for (const key of ['bytes-a', 'bytes-b', 'bytes-c']) {
      retainStructuredReadResume(key, large)
    }
    expect(takeStructuredReadResume('bytes-a')).toBeUndefined()
    expect(takeStructuredReadResume('bytes-b')).toBeDefined()
    expect(takeStructuredReadResume('bytes-c')).toBeDefined()
  })
})
