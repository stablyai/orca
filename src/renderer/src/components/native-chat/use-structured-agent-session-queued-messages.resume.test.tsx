// @vitest-environment happy-dom

// Resume uses the shared fenced write path; serialize presses, show one failure toast and keep Resume as the retry.

import { useCallback, useRef } from 'react'
import { act, cleanup, renderHook, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryResult,
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'

type ResumeParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: ResumeParams) => Promise<unknown>>(),
  toastError: vi.fn(),
  updateSettings: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: mocks.updateSettings }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import {
  reduceStructuredAgentSession,
  EMPTY_STRUCTURED_AGENT_SESSION
} from '../../../../shared/structured-agent-session-reducer'

// Keep the host fixture's Node imports outside the renderer compiler while executing its real publisher.
const { createQueuedMessageTestRig } = await vi.importActual<{
  createQueuedMessageTestRig: (options: { restartable: true }) => Promise<{
    workingSend: () => Promise<string>
    send: (text: string, delivery?: 'queue-if-active') => { id: string; result: Promise<unknown> }
    submission: (id: string) => Promise<{ handedOverAt?: number } | undefined>
    stop: () => Promise<unknown>
    dispose: () => Promise<void>
    host: {
      history: (request: {
        sessionId: string
        direction: 'tail'
      }) => Promise<AgentSessionHistoryResult>
    }
  }>
}>(
  '../../../../main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
)

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import { useNativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

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
  submissions?: AgentJournalSubmission[]
  sending?: StructuredAgentSessionPendingSend[]
  isWorking?: boolean
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
        submissions: input.submissions ?? [],
        hasPendingPrompt: false,
        isWorking: input.isWorking ?? false,
        sending: input.sending,
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

describe('published recovery membership through the Resume controller', () => {
  const stopped = { reason: 'stopped' } as const
  const recovery = card('R', {
    state: 'waiting',
    paused: true
  })
  const q = card('Q', { position: 3, state: 'returned' })
  const w1 = card('W1', { position: 2 })
  const w2 = card('W2', { position: 4 })
  const hidden = (id: string): AgentJournalSubmission => ({
    clientMessageId: `handoff-${id}`,
    queuedMessageId: id,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  })

  it.each([1, 2])(
    'renders normal Resume beside %i uncertain originals without synthetic actions',
    async (count) => {
      const rig = await createQueuedMessageTestRig({ restartable: true })
      onTestFinished(() => rig.dispose())
      await rig.workingSend()
      await rig.send('W1', 'queue-if-active').result
      await rig.send('W2', 'queue-if-active').result
      await rig.stop()
      if (count === 2) {
        const sent = rig.send('second unknown original')
        await sent.result
        await vi.waitFor(async () =>
          expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined()
        )
        await rig.stop()
      }
      let state = EMPTY_STRUCTURED_AGENT_SESSION
      await vi.waitFor(async () => {
        const result = await rig.host.history({ sessionId: 'session-alpha', direction: 'tail' })
        if (!result.ok) {
          throw new Error('history refused')
        }
        expect(result.page.queuedMessages).toHaveLength(2)
        state = reduceStructuredAgentSession(state, { type: 'history-page', page: result.page })
      })
      expect(state.queuedMessages?.every((card) => card.state === 'waiting')).toBe(true)
      mocks.call.mockResolvedValue(RESUMED)
      const { result } = renderController({
        queuedMessages: state.queuedMessages ?? [],
        queuePause: state.queuePause ?? null
      })
      render(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList chatWorktreeId={null} controller={result.current} />
        </TooltipProvider>
      )
      expect(screen.getAllByRole('listitem')).toHaveLength(2)
      expect(screen.queryAllByRole('button', { name: 'Send' })).toHaveLength(0)
      expect(screen.getAllByRole('button', { name: 'Steer' })).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
      await act(() => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
      expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'agentSession.queuedMessagesResume',
        { envelope: expect.anything() }
      )
    }
  )

  it('never offers Resume for a local Sending placeholder with a stale host pause', () => {
    const { result } = renderController({
      queuedMessages: [],
      isWorking: true,
      sending: [
        {
          clientMessageId: 'local',
          sessionId: 'session-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'on its way' }] },
          previewUris: [],
          queuedAt: 1,
          phase: 'sending',
          issued: true,
          delivery: 'queue-if-active'
        }
      ]
    })
    render(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList chatWorktreeId={null} controller={result.current} />
      </TooltipProvider>
    )
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(result.current.cards).toMatchObject([{ messageId: 'local', hold: 'sending' }])
    expect(result.current.pause).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('uses published membership before hiding catch-up handoffs; old-host Q still blocks its suffix', () => {
    const { result, rerender } = renderController({ queuedMessages: [recovery, w1, q, w2] })
    expect(result.current.pause).toEqual(stopped)
    rerender({ queuedMessages: [recovery, w1, q, w2], submissions: [hidden('W1')] })
    expect(result.current.cards.map((c) => c.messageId)).toEqual(['R', 'Q', 'W2'])
    expect(result.current.cards.at(-1)?.hold).toBe('behind-returned')
    expect(result.current.pause).toBeNull()
    rerender({
      queuedMessages: [w1, card('W0', { position: 2.5 }), q, w2],
      submissions: [hidden('W1')]
    })
    expect(result.current.pause).toEqual(stopped)
    for (const queuedMessages of [
      [q, w2],
      [recovery],
      [],
      [card('P', { paused: true })],
      [card(recovery.messageId, { ...recovery, state: 'returned', paused: undefined }), w2]
    ]) {
      rerender({ queuedMessages })
      expect(result.current.pause).toBeNull()
    }
    rerender({ queuedMessages: [w1], submissions: [hidden('W1')] })
    expect(result.current.cards).toEqual([])
    expect(result.current.pause).toBeNull()
    rerender({ queuedMessages: [w1, { ...recovery, position: 3 }, w2], queuePause: null })
    expect(result.current.cards.map((c) => c.hold)).toEqual(['turn', 'paused', 'turn'])
    expect(result.current.pause).toBeNull()
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
