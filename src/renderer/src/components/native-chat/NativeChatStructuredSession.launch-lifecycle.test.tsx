// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/lib/structured-agent-session-launch-message', () =>
  moduleFactories.structuredAgentSessionLaunchMessage()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'

const NOT_SIGNED_IN = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'notSignedIn' }
} as const
// Retry beside it is the resend, so the words keep only the step before it.
const NOT_SIGNED_IN_TEXT = "Codex isn't signed in. Run `codex login`."

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

function composerSend(): (text: string, attachments: unknown[]) => boolean | 'queued' {
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

  it('keys a floating chat launch by its owner even before any path context exists', () => {
    mocks.ownerWorktreeId = FLOATING_TERMINAL_WORKTREE_ID
    mocks.fileLinkContext = null
    mocks.launchLifecycle = 'failed'
    render(sessionView())

    expect(mocks.lifecycleLookup).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID, 'session-1')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retryLaunch).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID, 'session-1')
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

  // The message rides the restart as its first message, held until the chat exists.
  it('relaunches a failed start on send, with the message as its first message', () => {
    mocks.launchLifecycle = 'failed'
    render(sessionView())

    expect(composerSend()('restart and say hi', [])).toBe(true)
    // The relaunch is launch Retry's own: a new create operation under the same session.
    expect(mocks.retryLaunch).toHaveBeenCalledExactlyOnceWith('wt-1', 'session-1')
    expect(mocks.relaunchWithMessage).toHaveBeenCalledWith(
      'wt-1',
      'session-1',
      'restart and say hi'
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['pending', 'visibility-unknown'] as const)(
    'takes no send while the chat is %s: Send is off and the text stays',
    (lifecycle) => {
      mocks.launchLifecycle = lifecycle
      render(sessionView())

      expect(composerSend()('sent while starting', [])).toBe(false)
      expect(mocks.composerProps?.structuredTransport?.sendOut).toBe(true)
      expect(mocks.retryLaunch).not.toHaveBeenCalled()
      expect(mocks.send).not.toHaveBeenCalled()
    }
  )

  // Launch Retry relaunches the chat, and the reader may have scrolled up in it.
  it('brings the latest into view when launch Retry relaunches a failed chat', async () => {
    mocks.launchLifecycle = 'failed'
    render(sessionView())
    await screen.findByRole('button', { name: 'Retry' })
    mocks.revealLatest.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(mocks.revealLatest).toHaveBeenCalledOnce()
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
