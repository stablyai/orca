// @vitest-environment happy-dom

import type * as LaunchRegistry from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as LaunchOptions from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks, launchModule } = await vi.hoisted(
  async () => {
    const setup = (
      await import('./NativeChatStructuredSession.test-harness')
    ).createStructuredSessionMocks()
    return {
      ...setup,
      launchModule: setup.moduleFactories.structuredAgentSessionLaunch()
    }
  }
)

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', () => ({
  retryStructuredAgentSessionLaunch: launchModule.retryStructuredAgentSessionLaunch,
  relaunchFailedStructuredAgentSessionForMessage:
    launchModule.relaunchFailedStructuredAgentSessionForMessage
}))
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchRegistry>()),
    getStructuredAgentSessionLaunchLifecycle: launchModule.getStructuredAgentSessionLaunchLifecycle,
    getStructuredAgentSessionLaunchResumes: launchModule.getStructuredAgentSessionLaunchResumes,
    useStructuredAgentSessionLaunchLifecycle: launchModule.useStructuredAgentSessionLaunchLifecycle,
    useStructuredAgentSessionLaunchFailure: launchModule.useStructuredAgentSessionLaunchFailure
  })
)
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-options',
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchOptions>()),
    useStructuredAgentSessionLaunchSelection: launchModule.useStructuredAgentSessionLaunchSelection
  })
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () =>
  moduleFactories.structuredAgentSessionCall()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () =>
  moduleFactories.structuredAgentSessionSubscriptions()
)
vi.mock('../../session/structured/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../../appearance/use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('../../links/actions/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../links/actions/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('../../composer/NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('../../prompts/NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('../../prompts/NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'
import type { NativeChatStructuredComposerTransport } from '../../composer/submit/native-chat-structured-composer-transport'

const SESSION_ID = 'notice-card-session'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

function renderPane(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-notice-card-tab"
      sessionId={SESSION_ID}
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

function composerOnError(): NativeChatStructuredComposerTransport['onError'] {
  const onError = mocks.composerProps?.structuredTransport?.onError
  if (!onError) {
    throw new Error('composer transport has no onError')
  }
  return onError
}

it("shows the chat's own error and a composer error together, where one used to hide the other", () => {
  mocks.status = 'error'
  mocks.readRefusal = {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalUnavailable' }
  }
  renderPane()
  act(() => {
    composerOnError()('sonnet-9 is not an available model for this chat session.')
  })
  expect(screen.getByText("Orca couldn't open this chat's history right now.")).toBeTruthy()
  expect(screen.getByText('sonnet-9 is not an available model for this chat session.')).toBeTruthy()
  expect(document.querySelectorAll('[data-notice-kind="error"]')).toHaveLength(2)
})

it('keeps a send failure’s raw error apart and lets the user dismiss it', () => {
  renderPane()
  act(() => {
    composerOnError()('Your message was not sent.', {
      errorText: 'connect ECONNREFUSED /tmp/agent-host.sock'
    })
  })
  expect(screen.getByText('connect ECONNREFUSED /tmp/agent-host.sock').tagName).toBe('PRE')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText('Your message was not sent.')).toBeNull()
})
