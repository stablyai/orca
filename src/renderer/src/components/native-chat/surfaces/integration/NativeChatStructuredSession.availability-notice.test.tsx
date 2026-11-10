// @vitest-environment happy-dom

import type * as LaunchRegistry from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as LaunchOptions from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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
import { TooltipProvider } from '@/components/ui/tooltip'

// The host's verdict is a notice that never holds Send: it can be wrong while a send would work.

const CODEX_SIGNED_OUT = "Codex isn't signed in. Run `codex login`."
const CODEX_MISSING =
  "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
  mocks.queuedCards = []
})

function pane(agent: 'claude' | 'codex' = 'codex'): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="availability-tab"
        sessionId="availability-session"
        target={{ kind: 'local' }}
        agent={agent}
      />
    </TooltipProvider>
  )
}

it('stays dismissed for the same verdict, and shows again when it changes or comes back', () => {
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  const view = render(pane())
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(CODEX_SIGNED_OUT)).toBeNull()
  view.rerender(pane())
  expect(screen.queryByText(CODEX_SIGNED_OUT)).toBeNull()

  mocks.unavailable = { reason: 'cliMissing' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_MISSING)).toBeTruthy()
  // Changed, so the earlier dismissal is spent: the first verdict coming back shows again.
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

  mocks.unavailable = null
  view.rerender(pane())
  expect(screen.queryByText(CODEX_MISSING)).toBeNull()
  // Cleared, so the dismissed verdict is new again when it returns.
  mocks.unavailable = { reason: 'notSignedIn', account: 'system' }
  view.rerender(pane())
  expect(screen.getByText(CODEX_SIGNED_OUT)).toBeTruthy()
})
