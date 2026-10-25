// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

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
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

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
  // A history read that failed beside a transcript it keeps: the chat's own line.
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

const APPROVAL: AgentJournalRenderItem = JSON.parse(
  JSON.stringify({
    itemId: 'approval-item',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Run the plan?',
      detail: null,
      subject: { kind: 'plan', text: 'x' },
      options: [{ id: 'allow', label: 'Approve' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  })
)

it("keeps the notices above an approval card that takes the composer's place", () => {
  mocks.launchLifecycle = 'failed'
  mocks.promptItems = [APPROVAL]
  renderPane()
  expect(screen.queryByTestId('structured-composer')).toBeNull()
  expect(screen.getByText('Chat could not be started.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})
