// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import {
  useNativeChatRevealLatest,
  useNativeChatMessageListHandle
} from './use-native-chat-reveal-latest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import type { StructuredPromptItem } from './use-structured-agent-session'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'

const runtime = vi.hoisted(() => ({
  verified: vi.fn<() => Promise<boolean>>(async () => true),
  message: vi.fn(() => ({ cancel: () => {}, settleAfterMs: 0 }))
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessageVerified: runtime.verified,
  typeNativeChatCommand: runtime.verified,
  sendNativeChatMessage: runtime.message,
  sendNativeChatTypedCommand: runtime.message,
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: runtime.message
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: vi.fn(),
  waitForNativeChatPtyIdle: vi.fn(async () => {})
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: vi.fn() }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  vi.clearAllMocks()
})

function deferred<T>() {
  let settle: (value: T) => void = () => {
    throw new Error('Promise not initialized')
  }
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle: (value: T) => settle(value) }
}

const options: SessionOptionDescriptor[] = ['model', 'effort'].map((id) => ({
  id,
  label: id,
  kind: { type: 'select', currentValue: 'old', choices: [{ value: 'next', label: 'Next' }] },
  valueSource: 'reported',
  transport: 'agent-session',
  settable: true
}))

function transport(
  onSubmitted: () => void,
  setOption: () => Promise<boolean>
): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: options,
        invokeAction: async () => true,
        setOption,
        conversationCommands: ['compact'],
        runConversationCommand: async () => ({ accepted: await setOption(), error: null })
      }),
    optionsSurface: {
      getSnapshot: () => options,
      setOption: async () => ({ snapshot: options }),
      invokeAction: async () => ({ snapshot: options }),
      subscribe: () => () => {}
    },
    optionSnapshot: options,
    onError: vi.fn(),
    onSubmitted,
    runtime: 'remote',
    sessionId: 'session-a',
    runtimeEnvironmentId: 'review-environment'
  }
}

function useReviewTranscript() {
  const scrollRef = useRef(document.createElement('div'))
  Object.defineProperties(scrollRef.current, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 }
  })
  const contentRef = useRef<HTMLDivElement | null>(null)
  const scrollToEnd = useRef(vi.fn()).current
  const scroll = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: 10,
    isWorking: true,
    showsTailRow: true,
    isVisible: true,
    alignToViewportTop: vi.fn(),
    isAlignPending: () => false,
    scrollToEnd,
    restoreScrollOffset: vi.fn(),
    consumeProgrammaticScroll: () => false,
    reconcileReaderScroll: vi.fn()
  })
  const reveal = useNativeChatRevealLatest()
  useNativeChatMessageListHandle(reveal.messageListRef, scroll.scrollToBottom)
  return { ...reveal, scroll, scrollToEnd, element: scrollRef.current }
}

function readerScrollAway(transcript: ReturnType<typeof useReviewTranscript>) {
  act(() => transcript.scroll.readerLeavesEnd())
  transcript.element.scrollTop = 500
  const surface = render(
    <div data-testid="reader-scroll-surface" onScroll={transcript.scroll.onScroll} />
  )
  fireEvent.scroll(surface.getByTestId('reader-scroll-surface'))
  surface.unmount()
}

it('reveals a structured command at the press, before the host answers it', async () => {
  const host = deferred<boolean>()
  const hook = renderHook(() => {
    const transcript = useReviewTranscript()
    const t = transport(transcript.revealLatest, () => host.promise)
    const send = useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: 'send-r1-delay',
      imageAttachments: [],
      structuredTransport: t,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
    return { ...transcript, send }
  })
  readerScrollAway(hook.result.current)
  hook.result.current.scrollToEnd.mockClear()
  act(() => void hook.result.current.send('/compact'))
  expect(hook.result.current.scrollToEnd).toHaveBeenCalled()
  // The answer arriving later leaves a reader who has since scrolled away.
  readerScrollAway(hook.result.current)
  expect(hook.result.current.scroll.showJump).toBe(true)
  hook.result.current.scrollToEnd.mockClear()
  await act(async () => host.settle(true))
  expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
})

it('reveals a goal at the press, before the host sets it', async () => {
  const host = deferred<boolean>()
  const scope = 'send-r1-goal'
  writeNativeChatDraftCache(scope, '/goal')
  const hook = renderHook(
    ({ draft }: { draft: string }) => {
      const transcript = useReviewTranscript()
      const t = {
        ...transport(transcript.revealLatest, async () => true),
        threadGoal: { setObjective: () => host.promise }
      }
      const submit = useNativeChatComposerSubmit({
        structuredTransport: t,
        draftScopeKey: scope,
        draft,
        caret: draft.length,
        imageAttachments: [],
        disabled: false,
        sendPty: vi.fn(),
        sendStructured: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn()
      })
      return { ...transcript, submit }
    },
    { initialProps: { draft: '/goal' } }
  )
  hook.result.current.scrollToEnd.mockClear()
  act(() => hook.result.current.submit.send())
  writeNativeChatDraftCache(scope, 'Ship the parser')
  hook.rerender({ draft: 'Ship the parser' })
  readerScrollAway(hook.result.current)
  hook.result.current.scrollToEnd.mockClear()
  act(() => hook.result.current.submit.send())
  expect(hook.result.current.scrollToEnd).toHaveBeenCalled()
  readerScrollAway(hook.result.current)
  expect(hook.result.current.scroll.showJump).toBe(true)
  hook.result.current.scrollToEnd.mockClear()
  await act(async () => host.settle(true))
  expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
})

it.each(['/model', '/effort'])(
  'does not reveal history when %s only opens its picker',
  async (text) => {
    const onSubmitted = vi.fn()
    const t = transport(onSubmitted, async () => true)
    const hook = renderHook(() =>
      useNativeChatStructuredComposerSend({
        agent: 'codex',
        draftScopeKey: 'send-r1-picker',
        imageAttachments: [],
        structuredTransport: t,
        isComposing: () => false,
        clearSkillOrigin: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn()
      })
    )
    await act(async () => hook.result.current(text))
    expect(t.send).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
  }
)

function localAnswerArgs() {
  return {
    agent: 'omp' as const,
    disabled: false,
    isDispatchingSessionOption: false,
    resolveTarget: () => ({ ptyId: 'pty-a', settings: null }),
    onSlashCommand: vi.fn(),
    onSubmitted: vi.fn(),
    answerCommandLocally: () => 'Context: 20k / 272k tokens',
    sessionOptionsSurface: null,
    trackPendingSend: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    clearSkillOrigin: vi.fn(),
    clearImageAttachments: vi.fn(),
    setNotice: vi.fn()
  }
}

it('reveals the new transcript answer for a typed locally answered /context', () => {
  const args = {
    ...localAnswerArgs(),
    draft: '/context',
    imageAttachments: [],
    launchDraftResolved: true,
    classifySend: () => 'command' as const,
    terminalTabId: 'tab-a'
  }
  const hook = renderHook(() => useNativeChatPtyComposerSend(args))
  act(() => hook.result.current())
  expect(args.onSlashCommand).toHaveBeenCalledWith('/context', 'Context: 20k / 272k tokens')
  expect(runtime.message).not.toHaveBeenCalled()
  expect(args.onSubmitted).toHaveBeenCalledOnce()
})

it('reveals the new transcript answer for a picked locally answered /context', () => {
  const args = { ...localAnswerArgs(), setActiveSuggestion: vi.fn() }
  const hook = renderHook(() => useNativeChatPickerCommandDispatch(args))
  act(() =>
    hook.result.current({
      kind: 'command',
      id: 'context',
      name: 'context',
      token: '/context',
      skillCollision: false
    })
  )
  expect(args.onSlashCommand).toHaveBeenCalledWith('/context', 'Context: 20k / 272k tokens')
  expect(runtime.message).not.toHaveBeenCalled()
  expect(args.onSubmitted).toHaveBeenCalledOnce()
})

it('reveals only the pane whose option send it was, at the press', async () => {
  const host = deferred<boolean>()
  runtime.verified.mockImplementationOnce(() => host.promise)
  const revealA = vi.fn()
  const revealB = vi.fn()
  const hook = renderHook(
    ({ ptyId }: { ptyId: string }) => {
      const reveal = useNativeChatRevealLatest()
      useNativeChatMessageListHandle(reveal.messageListRef, ptyId === 'pty-a' ? revealA : revealB)
      return useNativeChatSessionOptionCommand({
        agent: 'codex',
        disabled: false,
        resolveTarget: () => ({ ptyId, settings: null }),
        onSubmitted: reveal.revealLatest
      })
    },
    { initialProps: { ptyId: 'pty-a' } }
  )
  let sending: Promise<unknown> = Promise.resolve()
  await act(async () => {
    sending = Promise.resolve(hook.result.current.dispatch('/model next'))
  })
  expect(runtime.verified).toHaveBeenCalledOnce()
  expect(revealA).toHaveBeenCalledOnce()
  hook.rerender({ ptyId: 'pty-b' })
  await act(async () => {
    host.settle(true)
    await sending
  })
  expect(revealA).toHaveBeenCalledOnce()
  expect(revealB).not.toHaveBeenCalled()
})

it('reveals a PTY option send at the press, before the terminal confirms it', async () => {
  const host = deferred<boolean>()
  runtime.verified.mockImplementationOnce(() => host.promise)
  const hook = renderHook(() => {
    const transcript = useReviewTranscript()
    const command = useNativeChatSessionOptionCommand({
      agent: 'codex',
      disabled: false,
      resolveTarget: () => ({ ptyId: 'pty-a', settings: null }),
      onSubmitted: transcript.revealLatest
    })
    return { ...transcript, command }
  })
  readerScrollAway(hook.result.current)
  hook.result.current.scrollToEnd.mockClear()
  let sending: Promise<unknown> = Promise.resolve()
  await act(async () => {
    sending = Promise.resolve(hook.result.current.command.dispatch('/model next'))
  })
  expect(hook.result.current.scrollToEnd).toHaveBeenCalled()
  readerScrollAway(hook.result.current)
  expect(hook.result.current.scroll.showJump).toBe(true)
  hook.result.current.scrollToEnd.mockClear()
  await act(async () => {
    host.settle(true)
    await sending
  })
  expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
})

it('control: a refused structured message does not reveal', async () => {
  const onSubmitted = vi.fn()
  const t = transport(onSubmitted, async () => true)
  vi.mocked(t.send).mockReturnValue(false)
  const hook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: 'send-r1-refused',
      imageAttachments: [],
      structuredTransport: t,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => hook.result.current('hello'))
  expect(t.send).toHaveBeenCalledWith('hello', [])
  expect(onSubmitted).not.toHaveBeenCalled()
})

const approval: StructuredPromptItem = {
  itemId: 'approval-1',
  revision: 3,
  sequence: 3,
  observedAt: 3,
  body: {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

it('reveals a structured prompt answer at the press, before the host accepts it', async () => {
  const host = deferred<null>()
  const hook = renderHook(() => {
    const transcript = useReviewTranscript()
    const submits = useStructuredNativeChatSubmitReveal(
      {
        respond: async () => host.promise,
        queuedMessages: {
          queueCapable: true,
          editCapable: false,
          editor: undefined,
          cards: [],
          pause: null,
          resuming: false,
          resume: async () => false,
          steer: async () => {},
          remove: async () => {},
          edit: async () => {},
          steerNewest: () => false,
          queueResume: undefined,
          queueHold: undefined
        }
      },
      vi.fn()
    )
    useNativeChatMessageListHandle(submits.messageListRef, transcript.scroll.scrollToBottom)
    return { ...transcript, submits }
  })
  readerScrollAway(hook.result.current)
  hook.result.current.scrollToEnd.mockClear()
  let answering: Promise<unknown> = Promise.resolve()
  act(() => {
    answering = hook.result.current.submits.respond(approval, { kind: 'option', optionId: 'allow' })
  })
  expect(hook.result.current.scrollToEnd).toHaveBeenCalled()
  readerScrollAway(hook.result.current)
  hook.result.current.scrollToEnd.mockClear()
  await act(async () => {
    host.settle(null)
    await answering
  })
  expect(hook.result.current.scrollToEnd).not.toHaveBeenCalled()
})

it('keeps an accepted queued draft out of transcript navigation', async () => {
  const onSubmitted = vi.fn()
  const t = transport(onSubmitted, async () => true)
  t.send = vi.fn(() => 'queued' as const)
  const hook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: 'queue-navigation',
      imageAttachments: [],
      structuredTransport: t,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => hook.result.current('Next task'))
  expect(t.send).toHaveBeenCalledWith('Next task', [])
  expect(onSubmitted).not.toHaveBeenCalled()
})
