// @vitest-environment happy-dom

// Resume uses the shared fenced write path; serialize presses, show one failure toast and keep Resume as the retry.

import { useCallback, useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'

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
import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'

const NO_EDIT: QueuedEditTransport = {
  target: { kind: 'local' },
  sessionId: 'session',
  capable: false,
  write: async () => ({ kind: 'dropped' })
}

const RESUMED = {
  ok: true,
  replayed: false,
  fence: 1,
  cursor: { epoch: 'epoch-1', sequence: 1 },
  value: { resumed: true }
}

function card(
  messageId: string,
  fields: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  return { messageId, position: 1, body, state: 'waiting', ...fields }
}

type ControllerInput = {
  queuedMessages?: AgentSessionQueuedMessage[]
  queuePause?: AgentSessionQueuePause | null
}

function renderController(initialProps: ControllerInput = {}) {
  const stateRef = { current: { fence: 1 } }
  return renderHook(
    (input: ControllerInput) => {
      const { mutate, write, admit, capturePresentation } = useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'local' },
        stateRef
      })
      return useStructuredAgentSessionQueuedMessages({
        enabled: true,
        queuedMessages: input.queuedMessages ?? [card('held')],
        queuePause: input.queuePause === undefined ? { reason: 'stopped' } : input.queuePause,
        submissions: [],
        hasPendingPrompt: false,
        isWorking: false,
        composerScopeKey: undefined,
        mutate,
        admit,
        capturePresentation,
        editTransport: { ...NO_EDIT, write }
      })
    },
    { initialProps }
  )
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("the header row's pause", () => {
  it.each(['stopped', 'cleared', 'some-newer-reason'])(
    "names the reason the host holds the queue for ('%s')",
    (reason) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host may publish a reason this client's type does not list.
      const queuePause = { reason } as AgentSessionQueuePause
      const { result } = renderController({ queuePause })
      expect(result.current.pause).toEqual({ reason })
    }
  )

  it('is absent over cards held only on their own or returned, and with no published pause', () => {
    const queuedMessages = [
      card('failed', { paused: true, pausedReason: 'send_failed' }),
      card('returned', { position: 2, state: 'returned' })
    ]
    expect(renderController({ queuedMessages }).result.current.pause).toBeNull()
    expect(renderController({ queuePause: null }).result.current.pause).toBeNull()
  })
})

describe('Clear all', () => {
  it('one failed press is one toast, however many cards it held', async () => {
    mocks.call.mockRejectedValue(new Error('socket closed'))
    const { result } = renderController({
      queuedMessages: [card('a'), card('b', { position: 2 }), card('c', { position: 3 })]
    })
    let cleared: boolean | undefined
    await act(async () => {
      cleared = await result.current.clear()
    })
    expect(cleared).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })
})

describe('Resume on a held queue', () => {
  it('calls queuedMessagesResume with only an envelope, and says nothing when it lands', async () => {
    mocks.call.mockResolvedValue(RESUMED)
    const { result } = renderController()
    await act(() => result.current.resume())
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [, method, params] = mocks.call.mock.calls[0] ?? []
    expect(method).toBe('agentSession.queuedMessagesResume')
    expect(Object.keys(params ?? {})).toEqual(['envelope'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps Resume actionable for an ordinary worker report behind a returned personal prefix, then applies the host release', async () => {
    mocks.call.mockResolvedValue(RESUMED)
    const worker = card('worker', {
      position: 2,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [],
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'run:r',
            dispatchId: null,
            messages: []
          }
        }
      }
    })
    const queuedMessages = [card('returned', { state: 'returned', returnedReason: null }), worker]
    const hook = renderController({ queuedMessages })
    expect(hook.result.current.pause).toEqual({ reason: 'stopped' })
    expect(hook.result.current.cards.find((card) => card.messageId === 'worker')?.hold).toBe('turn')
    await act(async () => expect(await hook.result.current.resume()).toBe(true))
    expect(mocks.call.mock.calls[0]?.[1]).toBe('agentSession.queuedMessagesResume')
    hook.rerender({ queuedMessages, queuePause: null })
    expect(hook.result.current.pause).toBeNull()
    hook.rerender({ queuedMessages: [worker], queuePause: { reason: 'stopped' } })
    expect(hook.result.current.pause).toEqual({ reason: 'stopped' })
  })

  it('a second press while one is in flight sends nothing', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.resume()
    })
    expect(result.current.queuePending).toBe('resume')
    await act(() => result.current.resume())
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(RESUMED)
      await pending
    })
    expect(result.current.queuePending).toBeNull()
  })

  it('a refused or failed Resume is one toast', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
    })
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderController()
    await act(() => result.current.resume())
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    await act(() => result.current.resume())
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('every press is its own operation: a failed Resume never pins the next one to its id', async () => {
    // Reusing an operation ID would replay old resumed:false/refusal instead of lifting today’s pause.
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message: 'Unknown operation.' }
    })
    mocks.call.mockResolvedValueOnce(RESUMED)
    const { result } = renderController()
    for (let press = 0; press < 3; press += 1) {
      await act(() => result.current.resume())
    }
    const ids = mocks.call.mock.calls.map(([, , params]) => params.envelope.clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})

function resumedResult(resumed = true) {
  return { ...RESUMED, value: { resumed } }
}

function useQueue(sessionId = 'session-1', fence: number | null = 1) {
  const { mutate, admit, capturePresentation } = useStructuredAgentSessionMutate({
    sessionId,
    target: { kind: 'local' },
    stateRef: { current: { fence } }
  })
  const queue = useStructuredAgentSessionQueuedMessages({
    enabled: true,
    queuedMessages: [card('held')],
    queuePause: { reason: 'stopped' },
    submissions: [],
    hasPendingPrompt: false,
    isWorking: false,
    composerScopeKey: undefined,
    mutate,
    admit,
    capturePresentation,
    editTransport: NO_EDIT
  })
  return { ...queue, capturePresentation }
}

function renderRevealingController(sessionId = 'session-1', fence: number | null = 1) {
  return renderHook(
    ({ isVisible }) => {
      const queue = useQueue(sessionId, fence)
      const submits = useStructuredNativeChatSubmitReveal(
        {
          queuedMessages: queue,
          respond: async () => null,
          capturePresentation: queue.capturePresentation
        },
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
        isAlignPending: () => false,
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
      expect(hook.result.current.submits.queuedMessages.queuePending).toBeNull()
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
        origin.rerender({ isVisible: true })
      }
      expect(scrollToEnd).not.toHaveBeenCalled()
    }
  )
})
