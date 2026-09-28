// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
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
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

// The read transport always hands the pane the host's words, so the retrying line must not hide
// behind them; those words show once, on the status line.
it('says a failed read keeps retrying, and shows the host message once', () => {
  mocks.status = 'error'
  mocks.readError = 'journal unreadable'
  mocks.messages = []

  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-read-error-tab"
      sessionId="read-error-session"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )

  expect(screen.getByText('Could not load conversation')).toBeTruthy()
  expect(
    screen.getByText('The transcript could not be read. Orca keeps trying to load it.')
  ).toBeTruthy()
  expect(screen.getAllByText('journal unreadable')).toHaveLength(1)
  expect(screen.queryByText(/Toggle back to the terminal/)).toBeNull()
})
