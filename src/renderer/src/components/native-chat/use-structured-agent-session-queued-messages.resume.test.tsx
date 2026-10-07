// @vitest-environment happy-dom

// Resume releases a held queue through its own RPC, over the same fenced write every card action
// uses. The header row offers it whenever the host holds a card it would send, the composer only
// while no turn runs too; one press at a time, a refusal or a failure is one toast, and Resume
// stays the way to try again.

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
  enabled?: boolean
  queuedMessages?: AgentSessionQueuedMessage[]
  queuePause?: AgentSessionQueuePause | null
  isWorking?: boolean
  hasPendingPrompt?: boolean
}

function renderController(initialProps: ControllerInput = {}) {
  const stateRef = { current: { fence: 1 } }
  return renderHook(
    (input: ControllerInput) => {
      const { mutate } = useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'local' },
        stateRef
      })
      return useStructuredAgentSessionQueuedMessages({
        enabled: input.enabled ?? true,
        queuedMessages: input.queuedMessages ?? [card('held')],
        queuePause: input.queuePause === undefined ? { reason: 'stopped' } : input.queuePause,
        submissions: [],
        hasPendingPrompt: input.hasPendingPrompt ?? false,
        isWorking: input.isWorking ?? false,
        composerScopeKey: undefined,
        mutate
      })
    },
    { initialProps }
  )
}

/** A press of the composer's Resume, which the controller offers only over a held queue. */
function resume(result: {
  current: { queueResume: { resume: () => Promise<boolean> } | undefined }
}) {
  const offered = result.current.queueResume
  if (!offered) {
    throw new Error('expected Resume to be offered')
  }
  return offered.resume()
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('whether Resume is offered', () => {
  it.each(['stopped', 'cleared', 'some-newer-reason'])(
    "over a card the host holds ('%s') with no turn running",
    (reason) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host may publish a reason this client's type does not list.
      const queuePause = { reason } as AgentSessionQueuePause
      const { result } = renderController({ queuePause })
      expect(result.current.queueResume).toBeDefined()
    }
  )

  it('not without the queue capability: an older host, or no fence yet while connecting', () => {
    expect(renderController({ enabled: false }).result.current.queueResume).toBeUndefined()
  })

  it('not while a turn runs, nor when nothing is held', () => {
    expect(renderController({ isWorking: true }).result.current.queueResume).toBeUndefined()
    expect(renderController({ queuePause: null }).result.current.queueResume).toBeUndefined()
    expect(renderController({ queuedMessages: [] }).result.current.queueResume).toBeUndefined()
  })

  it('not while a prompt waits, which holds the queue too: the composer shows beside one this build cannot answer', () => {
    const { result } = renderController({ hasPendingPrompt: true })
    expect(result.current.pause).toEqual({ reason: 'stopped' })
    expect(result.current.queueResume).toBeUndefined()
    expect(result.current.queueHold).toBeUndefined()
  })

  it('an idle chat with cards and no published pause (as after a restart): no row, Resume or "Send message?"', () => {
    const { result } = renderController({ queuePause: null })
    expect(result.current.cards.map((entry) => entry.hold)).toEqual(['turn'])
    expect(result.current.pause).toBeNull()
    expect(result.current.queueResume).toBeUndefined()
    expect(result.current.queueHold).toBeUndefined()
  })

  it('not over cards Resume would not send: held on their own, returned, or behind one', () => {
    const queuedMessages = [
      card('failed', { paused: true, pausedReason: 'send_failed' }),
      card('returned', { position: 2, state: 'returned' }),
      card('behind', { position: 3 })
    ]
    expect(renderController({ queuedMessages }).result.current.queueResume).toBeUndefined()
  })
})

describe('while a turn runs over held cards', () => {
  it('the header row still names the pause and offers Resume; the composer offers neither it nor "Send message?"', () => {
    // `isWorking` counts the queue's coming send, which the host names.
    const { result } = renderController({ isWorking: true })
    expect(result.current.pause).toEqual({ reason: 'stopped' })
    expect(result.current.queueResume).toBeUndefined()
    // Stopping reads as working: a message sent then joins the queue, with no dialog.
    expect(result.current.queueHold).toBeUndefined()
  })
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

  it("shares one Resume with the composer's: a press of either while one is in flight sends nothing", async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.resume()
    })
    expect(result.current.resuming).toBe(true)
    expect(result.current.queueResume?.resuming).toBe(true)
    await act(() => resume(result))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(RESUMED)
      await pending
    })
    expect(result.current.resuming).toBe(false)
  })
})

describe('Clear queue before a new message', () => {
  it('one failed press is one toast, however many cards it held', async () => {
    mocks.call.mockRejectedValue(new Error('socket closed'))
    const { result } = renderController({
      queuedMessages: [card('a'), card('b', { position: 2 }), card('c', { position: 3 })]
    })
    let cleared: boolean | undefined
    await act(async () => {
      cleared = await result.current.queueHold?.clear()
    })
    expect(cleared).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })
})

describe('Resume on a held queue', () => {
  it('calls queuedMessagesResume with only an envelope, and says nothing when it lands', async () => {
    mocks.call.mockResolvedValue(RESUMED)
    const { result } = renderController()
    await act(() => resume(result))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [, method, params] = mocks.call.mock.calls[0] ?? []
    expect(method).toBe('agentSession.queuedMessagesResume')
    expect(Object.keys(params ?? {})).toEqual(['envelope'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('a second press while one is in flight sends nothing', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = resume(result)
    })
    expect(result.current.queueResume?.resuming).toBe(true)
    await act(() => resume(result))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(RESUMED)
      await pending
    })
    expect(result.current.queueResume?.resuming).toBe(false)
  })

  it('a refused or failed Resume is one toast', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
    })
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderController()
    await act(() => resume(result))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    await act(() => resume(result))
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('every press is its own operation: a failed Resume never pins the next one to its id', async () => {
    // Resume names no target, so a replayed id would answer `{ resumed: false }` or repeat the
    // same refusal instead of lifting whatever holds the queue now.
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message: 'Unknown operation.' }
    })
    mocks.call.mockResolvedValueOnce(RESUMED)
    const { result } = renderController()
    for (let press = 0; press < 3; press += 1) {
      await act(() => resume(result))
    }
    const ids = mocks.call.mock.calls.map(([, , params]) => params.envelope.clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})

function resumedResult(resumed = true) {
  return { ...RESUMED, value: { resumed } }
}

/** The queue controller as a pane builds it, over the real mutation. */
function useQueue(sessionId = 'session-1', fence: number | null = 1) {
  const { mutate } = useStructuredAgentSessionMutate({
    sessionId,
    target: { kind: 'local' },
    stateRef: { current: { fence } }
  })
  return useStructuredAgentSessionQueuedMessages({
    enabled: true,
    queuedMessages: [card('held')],
    queuePause: { reason: 'stopped' },
    submissions: [],
    hasPendingPrompt: false,
    isWorking: false,
    composerScopeKey: undefined,
    mutate
  })
}

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
