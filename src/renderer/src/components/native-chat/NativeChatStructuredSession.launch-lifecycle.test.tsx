// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { readOutbox } from './structured-agent-session-outbox-storage'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'

const NOT_SIGNED_IN = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'notSignedIn' }
} as const
// Retry beside it is the resend, so the words keep only the step before it.
const NOT_SIGNED_IN_TEXT = 'Codex is not signed in for the selected account. Sign in first.'

function sessionView(): React.JSX.Element {
  return (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-tab-1"
      sessionId="session-1"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

function composerSend(): (text: string, attachments: unknown[]) => boolean {
  const send = mocks.composerProps?.structuredTransport?.send
  if (typeof send !== 'function') {
    throw new Error('Structured composer transport was not installed')
  }
  return (text, attachments) => send(text, attachments)
}

describe('NativeChatStructuredSession launch lifecycle', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it('shows the ordinary usable chat without a startup label while launch is pending', () => {
    mocks.launchLifecycle = 'pending'
    render(sessionView())

    expect(screen.getByTestId('structured-composer')).toBeTruthy()
    expect(mocks.controllerProps).toMatchObject({ transportEnabled: false })
    expect(screen.queryByText(/Starting (Claude|Codex) chat/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('keeps treating the chat as its launch after the launch record is deleted on publish', () => {
    mocks.launchLifecycle = 'pending'
    const { rerender } = render(sessionView())
    expect(mocks.controllerProps).toMatchObject({ launch: { kind: 'new' } })
    mocks.launchLifecycle = null
    rerender(sessionView())
    expect(mocks.controllerProps).toMatchObject({ launch: { kind: 'new' }, transportEnabled: true })
  })

  it('marks a launch that resumes a conversation from history as a resume', () => {
    mocks.launchLifecycle = 'pending'
    mocks.launchResumes = true
    render(sessionView())
    expect(mocks.controllerProps).toMatchObject({ launch: { kind: 'resume' } })
  })

  it('does not treat a reopened chat as a launch', () => {
    mocks.launchLifecycle = null
    render(sessionView())
    expect(mocks.controllerProps).not.toHaveProperty('launch')
  })

  it.each([
    ['failed', 'Chat could not be started.'],
    ['visibility-unknown', 'Chat connection could not be confirmed.']
  ] as const)('offers launch Retry for %s without naming the provider', (lifecycle, message) => {
    mocks.launchLifecycle = lifecycle
    render(sessionView())

    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByText(/Starting (Claude|Codex) chat/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retryLaunch).toHaveBeenCalledWith('wt-1', 'session-1')
  })

  it('words why a failed launch failed beside Retry from the refusal, never its code', () => {
    mocks.launchLifecycle = 'failed'
    mocks.launchFailure = NOT_SIGNED_IN
    render(sessionView())

    expect(screen.getByText(`Chat could not be started. ${NOT_SIGNED_IN_TEXT}`)).toBeTruthy()
    expect(screen.queryByText(/agent_session_/)).toBeNull()
  })

  it("keeps a step the Retry doesn't take, and drops one it does", () => {
    mocks.launchLifecycle = 'failed'
    mocks.launchFailure = {
      kind: 'refused',
      code: 'agent_session_conflict',
      details: { reason: 'claimConflicted' }
    }
    const { rerender } = render(sessionView())
    expect(
      screen.getByText(
        'Chat could not be started. This chat is still open in a terminal agent. Quit that agent to continue the chat here.'
      )
    ).toBeTruthy()

    mocks.launchFailure = {
      kind: 'refused',
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalUnavailable' }
    }
    rerender(sessionView())
    expect(
      screen.getByText(
        "Chat could not be started. Orca couldn't open this chat's history right now."
      )
    ).toBeTruthy()
  })

  it('says only that the chat could not start when the refusal names no reason', () => {
    mocks.launchLifecycle = 'failed'
    mocks.launchFailure = { kind: 'refused', code: 'agent_session_operation_invalid' }
    render(sessionView())

    expect(screen.getByText('Chat could not be started.')).toBeTruthy()
    expect(screen.queryByText(/agent_session_/)).toBeNull()
  })

  it('shows the saved Arguments cause and correction beside launch Retry', () => {
    mocks.launchLifecycle = 'failed'
    mocks.launchFailure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
      }
    })
    render(sessionView())

    expect(
      screen.getByText(
        "Codex couldn't start. Saved Arguments contain an unsupported option (--remote). Edit them in Settings > Agents > Arguments."
      )
    ).toBeTruthy()
    expect(screen.queryByText('Chat could not be started.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retryLaunch).toHaveBeenCalledWith('wt-1', 'session-1')
  })

  it('keeps a stale reason off a launch that is no longer failed', () => {
    mocks.launchLifecycle = 'visibility-unknown'
    mocks.launchFailure = NOT_SIGNED_IN
    render(sessionView())

    expect(screen.getByText('Chat connection could not be confirmed.')).toBeTruthy()
  })

  it('keeps the durable outbox parked until publication, then dispatches it once', async () => {
    mocks.mode = 'outbox'
    mocks.launchLifecycle = 'visibility-unknown'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })
    const { rerender } = render(sessionView())
    const send = mocks.composerProps?.structuredTransport?.send
    if (typeof send !== 'function') {
      throw new Error('Structured composer transport was not installed')
    }

    expect(send('queued while launching', [])).toBe(true)
    expect(mocks.call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.call).not.toHaveBeenCalled()

    mocks.launchLifecycle = 'published'
    rerender(sessionView())
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({ envelope: expect.objectContaining({ sessionId: 'session-1' }) })
    )
  })

  it('relaunches a failed start on send, then delivers the message once it publishes', async () => {
    mocks.mode = 'outbox'
    mocks.launchLifecycle = 'failed'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })
    const { rerender } = render(sessionView())

    expect(composerSend()('restart and say hi', [])).toBe(true)
    // The relaunch is launch Retry's own: a new create operation under the same session.
    expect(mocks.retryLaunch).toHaveBeenCalledExactlyOnceWith('wt-1', 'session-1')
    expect(mocks.call).not.toHaveBeenCalled()

    mocks.launchLifecycle = 'published'
    rerender(sessionView())
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({ envelope: expect.objectContaining({ sessionId: 'session-1' }) })
    )
  })

  it('keeps the message queued with the reason shown when the relaunch fails again', async () => {
    mocks.mode = 'outbox'
    mocks.launchLifecycle = 'failed'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })
    const { rerender } = render(sessionView())

    expect(composerSend()('still there?', [])).toBe(true)
    mocks.launchFailure = NOT_SIGNED_IN
    rerender(sessionView())

    expect(screen.getByText(`Chat could not be started. ${NOT_SIGNED_IN_TEXT}`)).toBeTruthy()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(readOutbox('session-1')).toEqual([
      expect.objectContaining({
        state: 'queued',
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'still there?' }] })
      })
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    mocks.launchLifecycle = 'published'
    rerender(sessionView())
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  })

  it('leaves a send into an unconfirmed start parked without relaunching', () => {
    mocks.mode = 'outbox'
    mocks.launchLifecycle = 'visibility-unknown'
    render(sessionView())

    expect(composerSend()('queued while unconfirmed', [])).toBe(true)
    expect(mocks.retryLaunch).not.toHaveBeenCalled()
  })

  it.each([null, 'published'] as const)(
    'enables provider transport for lifecycle %s',
    (lifecycle) => {
      mocks.launchLifecycle = lifecycle
      render(sessionView())

      expect(mocks.controllerProps).toMatchObject({ transportEnabled: true })
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    }
  )
})
