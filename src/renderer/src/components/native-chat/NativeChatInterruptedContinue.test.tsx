// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const hostLabel = (): string | null => 'studio-mac'
  const capability = (): 'unknown' | 'supported' | 'unsupported' => 'supported'
  const resuming: readonly string[] = []
  return {
    call: vi.fn(),
    capability: capability(),
    hostLabel: hostLabel(),
    resuming,
    launchPending: false
  }
})

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: async () => {}
}))
vi.mock('@/lib/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: () => 'Codex'
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => mocks.capability
}))
vi.mock('../native-chat-restart-runtimes', () => ({
  useNativeChatTargetRestartResuming: () => mocks.resuming
}))
vi.mock('../native-chat-launch-resume-decision', () => ({
  useNativeChatLaunchResumePending: () => mocks.launchPending
}))
vi.mock('./use-structured-agent-session-host-label', () => ({
  useStructuredAgentSessionHostLabel: () => mocks.hostLabel
}))

import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import {
  getStructuredAgentSessionSendNotice,
  setStructuredAgentSessionSendNotice
} from './structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  NativeChatInterruptedContinueButton,
  useNativeChatInterruptedContinuation
} from './NativeChatInterruptedContinue'

const TURN = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 1 })
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: 'studio-mac' }

const cutChat: AgentJournalRenderItem[] = [
  {
    itemId: TURN,
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'cut', state: 'interrupted', startedAt: 1, completedAt: 5 }
  },
  {
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stale-session:s:death-1-5' }),
    revision: 1,
    sequence: 2,
    observedAt: 6,
    turnScope: { kind: 'turn', turnItemId: TURN },
    body: { kind: 'status', text: 'Codex stopped.', tone: 'error', orcaStop: { cause: 'crash' } }
  }
]

const optionsSurface: NativeChatStructuredComposerTransport['optionsSurface'] = {
  getSnapshot: () => [],
  setOption: async () => ({ snapshot: [] }),
  invokeAction: async () => ({ snapshot: [] }),
  subscribe: () => () => {}
}

type Props = {
  journalItems?: readonly AgentJournalRenderItem[]
  submissions?: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
  isWorking?: boolean
  target?: RuntimeClientTarget
  transport?: NativeChatStructuredComposerTransport
  pending?: readonly { phase: 'sending' | 'recorded' }[]
}

function Harness(props: Props): React.JSX.Element {
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // The chat's own composer error, as NativeChatStructuredSession holds it.
  const [composerError, setComposerError] = useState<string | null>(null)
  const continuation = useNativeChatInterruptedContinuation({
    reportComposerError: setComposerError,
    focusComposer: () => {
      composerRef.current?.focus()
    },
    target: props.target ?? PAIRED,
    agent: 'codex',
    sessionId: 'session-1',
    journalItems: props.journalItems ?? cutChat,
    submissions: props.submissions ?? [],
    isWorking: props.isWorking ?? false,
    pending: props.pending ?? [],
    transport: props.transport ?? {
      capturePresentation: () => () => true,
      send: () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface,
      optionSnapshot: [],
      onError: () => {},
      runtime: 'remote',
      sessionId: 'session-1',
      runtimeEnvironmentId: 'studio-mac'
    }
  })
  return (
    <TooltipProvider delayDuration={0}>
      <textarea aria-label="Composer" ref={composerRef} />
      <span data-testid="offered">{continuation.view.offeredTurnItemId ?? 'none'}</span>
      <span data-testid="available">{String(continuation.view.continueAvailable)}</span>
      <span data-testid="remote">{String(continuation.view.remoteHost)}</span>
      <span data-testid="error">{composerError ?? continuation.continueError?.text ?? 'none'}</span>
      <button type="button" onClick={() => setComposerError(ATTACHMENTS)}>
        compose
      </button>
      {continuation.view.usageLimitTurnItemId === null ? null : (
        <NativeChatInterruptedContinueButton
          onContinue={continuation.view.continueUsageLimit}
          disabled={continuation.view.usageLimitContinueDisabled}
        />
      )}
      {continuation.view.offeredTurnItemId === null ? null : (
        <NativeChatInterruptedContinueButton onContinue={continuation.view.continueNow} />
      )}
    </TooltipProvider>
  )
}

const continueButton = () => screen.queryByRole('button', { name: 'Continue' })
const FAILED = "Couldn't continue this chat. Try again, or send a message."
const ATTACHMENTS = 'Remove attachments before using a chat-session command.'

beforeEach(() => {
  mocks.capability = 'supported'
  mocks.resuming = []
  mocks.launchPending = false
  mocks.hostLabel = 'studio-mac'
  mocks.call.mockReset()
})

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionSendsForTests()
  clearNativeChatComposerDraftsForTests()
})

describe('Continue on a reply an Orca stop cut off', () => {
  it("asks the chat's own host, paired or local, to continue that cut turn", () => {
    mocks.call.mockResolvedValue({ outcome: 'pending' })
    render(<Harness />)
    expect(screen.getByTestId('offered')).toHaveTextContent(TURN)

    fireEvent.click(continueButton()!)

    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(PAIRED, 'agentSession.continueInterrupted', {
      sessionId: 'session-1',
      turnItemId: TURN
    })
    expect(continueButton()).toBeNull()
    expect(screen.getByTestId('offered')).toHaveTextContent('none')
  })

  it("tells the chat's rows whether its host is remote", () => {
    render(<Harness />)
    expect(screen.getByTestId('remote')).toHaveTextContent('true')
    cleanup()
    render(<Harness target={{ kind: 'local' }} />)
    expect(screen.getByTestId('remote')).toHaveTextContent('false')
  })

  it('says what it does, for a reader and on hover', () => {
    render(<Harness />)
    expect(continueButton()).toHaveAccessibleDescription(
      'Continue, and the agent first checks whether its last step finished.'
    )
  })

  it('is not offered by a host without the operation; the user continues by sending', () => {
    mocks.capability = 'unsupported'
    render(<Harness />)
    expect(continueButton()).toBeNull()
    expect(screen.getByTestId('available')).toHaveTextContent('false')
  })

  it('tells the rows the same thing before the host answers, after it answers, and after a click', () => {
    mocks.capability = 'unknown'
    mocks.call.mockResolvedValue({ outcome: 'pending' })
    const { rerender } = render(<Harness />)
    expect(screen.getByTestId('available')).toHaveTextContent('true')
    expect(continueButton()).toBeNull()

    mocks.capability = 'supported'
    rerender(<Harness />)
    expect(screen.getByTestId('available')).toHaveTextContent('true')
    fireEvent.click(continueButton()!)

    expect(screen.getByTestId('available')).toHaveTextContent('true')
  })

  it('is not offered while the restart prompt or the launch is resuming this chat', () => {
    mocks.resuming = ['session-1']
    render(<Harness />)
    expect(continueButton()).toBeNull()
  })

  it("is not offered on this machine's chats while the launch may still resume them", () => {
    mocks.launchPending = true
    render(<Harness target={{ kind: 'local' }} />)
    expect(continueButton()).toBeNull()
    cleanup()
    // The launch resumes only this machine's chats; a paired server's chat is its own.
    render(<Harness />)
    expect(continueButton()).toBeInTheDocument()
  })

  it('is not offered once anything was sent, or while the agent works', () => {
    render(<Harness submissions={[{ dispatchState: 'pending' }]} />)
    expect(continueButton()).toBeNull()
    cleanup()
    render(<Harness isWorking />)
    expect(continueButton()).toBeNull()
  })

  it('is not offered for a cut no Orca stop explains', () => {
    render(<Harness journalItems={cutChat.slice(0, 1)} />)
    expect(continueButton()).toBeNull()
  })

  it('says so once, in the composer, and offers it again when the host refuses', async () => {
    mocks.call.mockResolvedValue({ outcome: 'refused', reason: 'agent_session_not_attached' })
    render(<Harness />)

    fireEvent.click(continueButton()!)
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)
    fireEvent.click(continueButton()!)
    expect(screen.getByTestId('error')).toHaveTextContent('none')
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)
  })

  it('says so and offers it again when the request fails', async () => {
    mocks.call.mockRejectedValue(new Error('offline'))
    render(<Harness />)

    fireEvent.click(continueButton()!)

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))
    expect(continueButton()).toBeInTheDocument()
  })

  it('replaces an older composer error with its own failure, and clears it when it goes through', async () => {
    mocks.call.mockResolvedValueOnce({ outcome: 'refused', reason: 'agent_session_conflict' })
    mocks.call.mockResolvedValueOnce({ outcome: 'pending' })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)

    fireEvent.click(continueButton()!)
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent(FAILED)

    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })

  it('leaves an unrelated composer error alone when the chat moves on by itself', () => {
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'compose' }))
    rerender(<Harness submissions={[{ dispatchState: 'pending' }]} />)
    expect(screen.getByTestId('error')).toHaveTextContent(ATTACHMENTS)
  })

  it('drops the line once the chat was continued, here or by another client', async () => {
    // The answer was lost after the host accepted it.
    mocks.call.mockRejectedValue(new Error('timed out'))
    const { rerender } = render(<Harness />)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))

    rerender(<Harness submissions={[{ dispatchState: 'pending' }]} />)

    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })

  it('leaves no line when a retry finds the chat already continued', async () => {
    mocks.call.mockRejectedValueOnce(new Error('timed out'))
    mocks.call.mockResolvedValueOnce({ outcome: 'superseded' })
    render(<Harness />)
    fireEvent.click(continueButton()!)
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(FAILED))

    fireEvent.click(continueButton()!)

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('error')).toHaveTextContent('none')
  })
})

it('keeps the draft through Continue admission, refusal, uncertainty and recorded-before-journal', async () => {
  const items: AgentJournalRenderItem[] = [
    {
      ...cutChat[0]!,
      body: {
        kind: 'turn',
        turnId: 'cut',
        state: 'completed',
        outcome: 'failure',
        startedAt: 1,
        completedAt: 5
      }
    },
    {
      ...cutChat[1]!,
      body: {
        kind: 'status',
        ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
      }
    }
  ]
  const scope = structuredAgentSessionDraftScopeKey('session-1')
  const draft = {
    text: 'My unfinished request',
    images: [{ id: 'attached', path: '/tmp/photo.png' }]
  }
  updateNativeChatComposerDraft(scope, draft, 'immediate')
  const options = { model: 'gpt-current', effort: 'high' }
  const uploading = { id: 'upload', path: '', pending: true, pendingName: 'next.png' }
  const reveal = vi.fn()
  function LiveHarness() {
    const sends = useStructuredAgentSessionSends({
      sessionId: 'session-1',
      target: PAIRED,
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: {
        capability: 'unsupported',
        followUpsQueue: false,
        isWorking: false,
        stopping: false,
        session: {},
        prompts: []
      },
      historyLoaded: false,
      sendOptions: () => options
    })
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => true,
      send: (text, images, request) =>
        sends.send(
          text,
          images.map((image) => ({ path: image.path, previewUri: image.path })),
          request
        ),
      onSubmitted: reveal,
      onError: vi.fn(),
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface,
      optionSnapshot: [],
      runtime: 'remote',
      sessionId: 'session-1',
      runtimeEnvironmentId: 'studio-mac'
    }
    return (
      <>
        <span>{uploading.pendingName}</span>
        <Harness journalItems={items} transport={transport} pending={sends.pending} />
      </>
    )
  }
  let answer = Promise.withResolvers<unknown>()
  mocks.call.mockImplementation(() => answer.promise)
  const { rerender } = render(<LiveHarness />)
  mocks.capability = 'unknown'
  rerender(<LiveHarness />)
  expect(continueButton()).toBeDisabled()
  mocks.capability = 'supported'
  rerender(<LiveHarness />)
  fireEvent.click(screen.getByRole('button', { name: 'compose' }))
  act(() => setStructuredAgentSessionSendNotice('session-1', 'Previous send failed'))
  continueButton()!.focus()
  fireEvent.click(continueButton()!)
  expect(screen.getByRole('textbox', { name: 'Composer' })).toHaveFocus()
  expect(getStructuredAgentSessionSendNotice('session-1')).toBeNull()
  expect(screen.getByTestId('error')).toHaveTextContent('none')
  expect(continueButton()).toBeNull()
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.call.mock.calls[0].slice(0, 3)).toMatchObject([
    PAIRED,
    'agentSession.send',
    {
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Continue where you left off.' }]
      },
      options,
      usageLimitContinuationOfTurnItemId: TURN
    }
  ])
  expect(reveal).toHaveBeenCalledOnce()
  expect(emitNativeChatMessageSent).toHaveBeenCalledWith({ agent: 'codex', runtime: 'remote' })
  await act(async () =>
    answer.resolve({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerRejected' },
        message: 'Refused'
      }
    })
  )
  await waitFor(() => expect(continueButton()).toBeInTheDocument())
  expect(screen.getByTestId('error')).toHaveTextContent(FAILED)
  expect(readNativeChatComposerDraft(scope)).toMatchObject(draft)
  // An old host gets the exact plain-send control shape, including after an uncertain attempt.
  mocks.capability = 'unsupported'
  answer = Promise.withResolvers<unknown>()
  rerender(<LiveHarness />)
  fireEvent.click(continueButton()!)
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  expect(mocks.call.mock.calls[1][2]).not.toHaveProperty('usageLimitContinuationOfTurnItemId')
  await act(async () => answer.reject(new Error('connection lost')))
  await waitFor(() =>
    expect(screen.getByTestId('error')).toHaveTextContent('Check the chat before trying again.')
  )
  expect(screen.getByTestId('error')).not.toHaveTextContent('was not sent')
  expect(readNativeChatComposerDraft(scope)).toMatchObject(draft)
  mocks.capability = 'supported'
  answer = Promise.withResolvers<unknown>()
  rerender(<LiveHarness />)
  fireEvent.click(continueButton()!)
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
  const id = mocks.call.mock.calls[2][2].envelope.clientOperationId
  await act(async () =>
    answer.resolve({
      ok: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 5 },
      value: { clientMessageId: id, submission: { clientMessageId: id, dispatchState: 'accepted' } }
    })
  )
  // Accepted before the journal arrives: the recorded sender entry still owns availability.
  expect(continueButton()).toBeNull()
  expect(readNativeChatComposerDraft(scope)).toMatchObject(draft)
  expect(screen.getByText('next.png')).toBeInTheDocument()
  expect(options).toEqual({ model: 'gpt-current', effort: 'high' })
})

it('keeps the notice view stable while Continue invokes the latest committed transport', () => {
  const items: AgentJournalRenderItem[] = [
    {
      ...cutChat[0]!,
      body: {
        kind: 'turn',
        turnId: 'cut',
        state: 'completed',
        outcome: 'failure',
        startedAt: 1,
        completedAt: 5
      }
    },
    {
      ...cutChat[1]!,
      body: {
        kind: 'status',
        ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
      }
    }
  ]
  const first = vi.fn(() => true)
  const latest = vi.fn(() => true)
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: first,
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface,
    optionSnapshot: [],
    onError: () => {},
    runtime: 'remote',
    sessionId: 'session-1',
    runtimeEnvironmentId: 'studio-mac'
  }
  const input = {
    target: PAIRED,
    agent: 'codex' as const,
    sessionId: 'session-1',
    journalItems: items,
    submissions: [],
    isWorking: false,
    pending: [],
    reportComposerError: vi.fn(),
    focusComposer: vi.fn(),
    transport
  }
  const { result, rerender } = renderHook((props) => useNativeChatInterruptedContinuation(props), {
    initialProps: input
  })
  const view = result.current.view
  rerender({ ...input, transport: { ...transport, send: latest } })
  expect(result.current.view).toBe(view)
  act(() => view.continueUsageLimit())
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledOnce()
})
