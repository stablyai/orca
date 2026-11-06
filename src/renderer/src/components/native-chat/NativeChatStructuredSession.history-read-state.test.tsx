// @vitest-environment happy-dom

import type * as LaunchRegistry from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as LaunchOptions from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

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

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

{
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
  })
}
