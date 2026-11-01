// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { legacySingleQuestionPromptItems } from './native-chat-structured-question-test-fixtures'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
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

const USAGE = {
  usedTokens: 42_000,
  windowTokens: 200_000,
  percentage: 21,
  estimated: false,
  categories: [{ name: 'Messages', tokens: 42_000 }]
}
const APPROVAL: AgentJournalRenderItem = {
  itemId: 'approval-item',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'approval',
    title: 'Allow command?',
    detail: 'pnpm test',
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

function pane() {
  return (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="context-usage-tab"
      sessionId="context-usage-session"
      target={{ kind: 'local' }}
      agent="claude"
    />
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

it('keeps usage available while questions or approvals take the composer slot', () => {
  mocks.contextUsage = USAGE
  const { rerender } = render(pane())
  expect(screen.getByTestId('structured-composer')).toBeTruthy()
  expect(document.querySelector('[data-native-chat-context-usage]')).toBeNull()
  expect(mocks.composerProps?.structuredTransport?.contextUsage).toEqual(USAGE)

  mocks.promptItems = legacySingleQuestionPromptItems
  mocks.contextUsage = null
  rerender(pane())
  expect(screen.queryByTestId('structured-composer')).toBeNull()
  expect(document.querySelector('[data-native-chat-context-usage]')).toBeNull()

  mocks.contextUsage = USAGE
  rerender(pane())
  const ring = document.querySelector<HTMLButtonElement>('button[data-native-chat-context-usage]')
  expect(ring?.classList.contains('text-chat-foreground-faint')).toBe(true)
  expect(ring?.getAttribute('aria-label')).toContain('42k')
  expect(ring?.getAttribute('aria-label')).toContain('200k')
  expect(ring?.getAttribute('aria-label')).toContain('21%')
  if (!ring) {
    throw new Error('Context usage was not shown with the question')
  }
  fireEvent.click(ring)
  expect(screen.getByText('Messages')).toBeTruthy()

  mocks.contextUsage = { ...USAGE, usedTokens: 80_000, percentage: 40 }
  rerender(pane())
  expect(document.querySelectorAll('button[data-native-chat-context-usage]')).toHaveLength(1)
  expect(ring.getAttribute('data-native-chat-context-usage')).toBe('40')

  mocks.promptItems = [APPROVAL]
  rerender(pane())
  expect(mocks.approvalCardProps?.approval.title).toBe('Allow command?')
  expect(document.querySelectorAll('button[data-native-chat-context-usage]')).toHaveLength(1)

  mocks.promptItems = []
  rerender(pane())
  expect(screen.getByTestId('structured-composer')).toBeTruthy()
  expect(document.querySelector('[data-native-chat-context-usage]')).toBeNull()
  expect(mocks.composerProps?.structuredTransport?.contextUsage).toEqual(mocks.contextUsage)
})

it('does not add a second control beside the composer for an unanswerable approval', () => {
  const newer: AgentJournalRenderItem = JSON.parse(
    JSON.stringify({ ...APPROVAL, body: { ...APPROVAL.body, subject: { kind: 'diff' } } })
  )
  mocks.contextUsage = USAGE
  mocks.promptItems = [newer]
  render(pane())
  expect(screen.getByTestId('structured-composer')).toBeTruthy()
  expect(mocks.approvalCardProps).toMatchObject({ shouldFocus: false })
  expect(mocks.composerProps?.structuredTransport?.contextUsage).toEqual(USAGE)
  expect(document.querySelector('[data-native-chat-context-usage]')).toBeNull()
})
