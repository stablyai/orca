// @vitest-environment happy-dom

// Resume lifts the queue's pause through its own RPC, over the same fenced write every card action
// uses: a refusal or a failure is one toast, and the Resume button is the way to try again.

import { useCallback, useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ResumeParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: ResumeParams) => Promise<unknown>>(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import { useNativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

function resumedResult(resumed = true) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: { resumed }
  }
}

function useQueue(sessionId = 'session-1', fence: number | null = 1) {
  const { mutate } = useStructuredAgentSessionMutate({
    sessionId,
    target: { kind: 'local' },
    stateRef: { current: { fence } }
  })
  return useStructuredAgentSessionQueuedMessages({
    enabled: true,
    queuedMessages: [],
    queuePause: { reason: 'stopped' },
    submissions: [],
    hasPendingPrompt: false,
    composerScopeKey: undefined,
    mutate
  })
}

function renderController() {
  return renderHook(() => useQueue())
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('Resume on a paused queue', () => {
  it('calls queuedMessagesResume with only an envelope, and says nothing when it lands', async () => {
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { resumed: true }
    })
    const { result } = renderController()
    expect(result.current.pause).toEqual({ reason: 'stopped' })
    await act(async () => expect(await result.current.resume()).toBe(true))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [, method, params] = mocks.call.mock.calls[0] ?? []
    expect(method).toBe('agentSession.queuedMessagesResume')
    expect(Object.keys(params ?? {})).toEqual(['envelope'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('a refused or failed Resume is one toast', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
    })
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderController()
    await act(async () => expect(await result.current.resume()).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    await act(async () => expect(await result.current.resume()).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('every press is its own operation: a failed Resume never pins the next one to its id', async () => {
    // Resume names no target, so a replayed id would answer `{ resumed: false }` or repeat the
    // same refusal instead of lifting whatever pause holds now.
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message: 'Unknown operation.' }
    })
    mocks.call.mockResolvedValueOnce({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { resumed: true }
    })
    const { result } = renderController()
    for (let press = 0; press < 3; press += 1) {
      await act(() => result.current.resume())
    }
    const ids = mocks.call.mock.calls.map(([, , params]) => params.envelope.clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('reports a Resume in flight until it settles', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending = Promise.resolve(false)
    act(() => {
      pending = result.current.resume()
    })
    expect(result.current.resuming).toBe(true)
    await act(async () => expect(await result.current.resume()).toBe(false))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { resumed: true }
      })
      expect(await pending).toBe(true)
    })
    expect(result.current.resuming).toBe(false)
  })
})

function renderRevealingController(sessionId = 'session-1', fence: number | null = 1) {
  return renderHook(
    ({ isVisible }) => {
      const queue = useQueue(sessionId, fence)
      const submits = useStructuredNativeChatSubmitReveal(
        { queuedMessages: queue, respond: async () => null, retry: vi.fn() },
        vi.fn()
      )
      const scrollRef = useRef(document.createElement('div'))
      Object.defineProperties(scrollRef.current, {
        clientHeight: { configurable: true, value: 500 },
        scrollHeight: { configurable: true, value: 2000 }
      })
      const contentRef = useRef<HTMLDivElement | null>(null)
      const scrollToEnd = useRef(vi.fn()).current
      const restoreScrollOffset = useCallback((offset: number) => {
        scrollRef.current.scrollTop = offset
      }, [])
      const scroll = useNativeChatTranscriptScroll({
        scrollRef,
        contentRef,
        itemCount: 10,
        isWorking: false,
        showsTailRow: false,
        isVisible,
        alignToViewportTop: vi.fn(),
        scrollToEnd,
        restoreScrollOffset,
        consumeProgrammaticScroll: () => false,
        reconcileReaderScroll: vi.fn()
      })
      useNativeChatMessageListHandle(submits.messageListRef, scroll.scrollToBottom)
      return { submits, scroll, scrollToEnd }
    },
    { initialProps: { isVisible: true } }
  )
}

function startResume(hook: ReturnType<typeof renderRevealingController>) {
  act(() => hook.result.current.scroll.readerLeavesEnd())
  hook.result.current.scrollToEnd.mockClear()
  let pending = Promise.resolve(false)
  act(() => {
    pending = hook.result.current.submits.queuedMessages.resume()
  })
  expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
  return pending
}

describe('Resume transcript navigation through the real mutation and queue controllers', () => {
  it.each(['refused', 'failed', 'noop', 'replayed', 'null'] as const)(
    'does not reveal for a %s result',
    async (outcome) => {
      if (outcome === 'failed') {
        mocks.call.mockRejectedValueOnce(new Error('socket closed'))
      } else if (outcome === 'refused') {
        mocks.call.mockResolvedValueOnce({
          ok: false,
          refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
        })
      } else {
        mocks.call.mockResolvedValueOnce({
          ...resumedResult(false),
          replayed: outcome === 'replayed'
        })
      }
      const hook = renderRevealingController('session-1', outcome === 'null' ? null : 1)
      const pending = startResume(hook)
      await act(async () => expect(await pending).toBe(false))
      expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
      expect(hook.result.current.submits.queuedMessages.resuming).toBe(false)
      expect(mocks.toastError).toHaveBeenCalledTimes(
        outcome === 'failed' || outcome === 'refused' ? 1 : 0
      )
    }
  )

  it('reveals only the pane that pressed Resume, after success, and ignores a duplicate press', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const origin = renderRevealingController()
    const other = renderRevealingController()
    other.result.current.scrollToEnd.mockClear()
    const pending = startResume(origin)
    await act(async () => {
      expect(await origin.result.current.submits.queuedMessages.resume()).toBe(false)
    })
    expect(origin.result.current.scrollToEnd).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(resumedResult())
      expect(await pending).toBe(true)
    })
    expect(origin.result.current.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(other.result.current.scrollToEnd).not.toHaveBeenCalled()
  })

  // Lifting the pause is slow and the reader can switch away meanwhile; that pane stays put.
  it.each(['hide', 'unmount'] as const)(
    'does not reveal a pane that is %s when Resume succeeds',
    async (action) => {
      const answer = Promise.withResolvers<unknown>()
      mocks.call.mockReturnValueOnce(answer.promise)
      const origin = renderRevealingController()
      const scrollToEnd = origin.result.current.scrollToEnd
      const pending = startResume(origin)
      if (action === 'hide') {
        origin.rerender({ isVisible: false })
      } else {
        origin.unmount()
      }
      await act(async () => {
        answer.resolve(resumedResult())
        await pending
      })
      if (action === 'hide') {
        // Shown again, it is where the reader left it.
        origin.rerender({ isVisible: true })
      }
      expect(scrollToEnd).not.toHaveBeenCalled()
    }
  )
})
