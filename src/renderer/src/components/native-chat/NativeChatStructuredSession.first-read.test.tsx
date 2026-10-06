// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
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
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const START_A_CHAT = 'Start a chat with Codex'
const LOADING_TEXT = /Loading conversation|Reading the agent transcript/

function loadingCue(): HTMLElement | null {
  return document.querySelector('[data-native-chat-loading-cue="true"]')
}

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

describe('NativeChatStructuredSession before its first read settles', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it.each(['idle', 'loading'] as const)(
    'shows a reopened chat only a textless loading cue while its read is %s',
    (status) => {
      mocks.messages = []
      mocks.status = status
      render(sessionView())

      const cue = screen.getByRole('status', { name: 'Loading chat' })
      expect(cue).toBe(loadingCue())
      expect(cue.textContent).toBe('')
      expect(screen.queryAllByText(LOADING_TEXT)).toHaveLength(0)
      expect(screen.queryByText(START_A_CHAT)).toBeNull()
      expect(screen.getByTestId('structured-composer')).toBeTruthy()
    }
  )

  it('drops the cue for the empty state once the read settles with nothing in it', () => {
    mocks.messages = []
    mocks.status = 'idle'
    const { rerender } = render(sessionView())
    expect(screen.queryByText(START_A_CHAT)).toBeNull()

    mocks.status = 'ready'
    rerender(sessionView())
    expect(screen.getByText(START_A_CHAT)).toBeTruthy()
    expect(loadingCue()).toBeNull()
  })

  it('shows no cue over a transcript, even while a read is still loading', () => {
    mocks.status = 'loading'
    render(sessionView())

    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(loadingCue()).toBeNull()
  })

  it('does not hold a cancelled resume on the cue', () => {
    mocks.messages = []
    mocks.launchLifecycle = 'cancelled'
    mocks.launchResumes = true
    mocks.status = 'ready'
    render(sessionView())

    expect(loadingCue()).toBeNull()
  })

  it('keeps a chat this view started on its empty state through publish and the first read', () => {
    mocks.messages = []
    mocks.launchLifecycle = 'pending'
    // The real controller reports `ready` while the launch has not published.
    mocks.status = 'ready'
    const { rerender } = render(sessionView())
    expect(screen.getByText(START_A_CHAT)).toBeTruthy()

    mocks.launchLifecycle = null
    for (const status of ['idle', 'loading', 'ready'] as const) {
      mocks.status = status
      rerender(sessionView())
      expect(screen.getByText(START_A_CHAT)).toBeTruthy()
      expect(screen.queryAllByText(LOADING_TEXT)).toHaveLength(0)
      expect(loadingCue()).toBeNull()
    }
  })

  it.each([
    ['failed', 'Chat could not be started.'],
    ['visibility-unknown', 'Chat connection could not be confirmed.']
  ] as const)(
    'leaves a %s resume blank beside its Retry line, since nothing is reading it',
    (lifecycle, line) => {
      mocks.messages = []
      mocks.launchLifecycle = lifecycle
      mocks.launchResumes = true
      mocks.status = 'ready'
      render(sessionView())

      expect(loadingCue()).toBeNull()
      expect(screen.queryByText(START_A_CHAT)).toBeNull()
      expect(screen.getByText(line)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    }
  )

  it('does not invite a first message into a resumed chat whose history is not read yet', () => {
    mocks.messages = []
    mocks.launchLifecycle = 'pending'
    mocks.launchResumes = true
    mocks.status = 'ready'
    render(sessionView())

    expect(screen.queryByText(START_A_CHAT)).toBeNull()
    expect(screen.queryAllByText(LOADING_TEXT)).toHaveLength(0)
    expect(loadingCue()).not.toBeNull()
  })
})
