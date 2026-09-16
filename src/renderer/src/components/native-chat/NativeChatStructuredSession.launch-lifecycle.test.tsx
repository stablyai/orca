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
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

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
