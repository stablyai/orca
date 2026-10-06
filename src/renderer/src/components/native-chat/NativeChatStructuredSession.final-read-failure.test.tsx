// @vitest-environment happy-dom

// A read no retry gets past (damage, a newer Orca's chat) takes the whole pane, even after the
// transcript loaded: its words alone, and nothing that could only be refused again.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

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
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

const APPROVAL: AgentJournalRenderItem = JSON.parse(
  JSON.stringify({
    itemId: 'approval-item',
    revision: 3,
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

/** A chat with its transcript on screen, a pending approval, a goal, a queued card and a running
 *  background task, whose read then fails with `reason`. */
function renderLoadedChatThenFailedRead(
  reason: 'journalCorrupt' | 'journalUnavailable' | 'journalWrittenByNewerOrca'
): void {
  mocks.status = 'error'
  mocks.readRefusal = { code: 'agent_session_journal_unreadable', details: { reason } }
  mocks.turnId = 'turn-1'
  mocks.promptItems = [APPROVAL]
  mocks.threadGoal = {
    goal: {
      objective: 'Ship',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 1,
      createdAt: 1,
      updatedAt: 1
    },
    pending: false,
    change: vi.fn()
  }
  mocks.queuedCards = [
    { messageId: 'draft-1', position: 1, text: 'queued text', state: 'waiting', hold: 'turn' }
  ]
  mocks.monitoringBackgroundTasks = true
  mocks.backgroundTasks = [{ id: 'task-agent', kind: 'agent' }]
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="final-read-failure-tab"
        sessionId="final-read-failure-session"
        target={{ kind: 'environment', environmentId: 'env-1' }}
        agent="codex"
      />
    </TooltipProvider>
  )
}

it.each([
  ['journalCorrupt', 'Unable to load this chat.'],
  ['journalWrittenByNewerOrca', 'This chat was saved by a newer Orca. Update Orca to open it.']
] as const)('a %s read after the transcript loaded leaves only its words', (reason, words) => {
  renderLoadedChatThenFailedRead(reason)

  expect(screen.getAllByText(words)).toHaveLength(1)
  expect(screen.queryByTestId('message-list')).toBeNull()
  expect(mocks.composerProps).toBeNull()
  expect(mocks.approvalCardProps).toBeNull()
  expect(document.querySelector('[data-native-chat-thread-goal]')).toBeNull()
  expect(document.querySelector('[data-queued-message-id="draft-1"]')).toBeNull()
  expect(document.querySelector('[data-native-chat-background-tasks]')).toBeNull()
})

it('a failed read that can clear keeps the transcript and every control', () => {
  renderLoadedChatThenFailedRead('journalUnavailable')

  expect(screen.getByTestId('message-list')).toBeTruthy()
  expect(mocks.approvalCardProps).not.toBeNull()
  expect(document.querySelector('[data-queued-message-id="draft-1"]')).not.toBeNull()
  expect(document.querySelector('[data-native-chat-background-tasks]')).not.toBeNull()
})
