import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { agentSessionTabFixture } from './native-chat-workspace-test-fixtures'
import { useAppStore } from '@/store'
import { makeTabGroup } from '@/store/slices/store-test-helpers'
// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { inPlaceSwitchCapability } from '../../../../shared/structured-agent-cli-conversation-adoption'

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

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
  vi.restoreAllMocks()
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
}

{
  // Final read refusals replace even loaded content: every action would only be refused again.

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

  /** Fail a loaded chat with an approval, goal, queued draft and background task still present. */
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
      hostChanges: true,
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
}

it('holds the native header switch until capabilities hydrate, with no copy button beside it', async () => {
  const tab = agentSessionTabFixture('native-controls', 'wt-1', {
    entityId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture(),
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'native', { path: '/repo' })] },
    unifiedTabsByWorktree: { 'wt-1': [tab] },
    groupsByWorktree: {
      'wt-1': [
        makeTabGroup({
          id: tab.groupId,
          worktreeId: 'wt-1',
          tabOrder: [tab.id],
          activeTabId: tab.id
        })
      ]
    },
    activeGroupIdByWorktree: { 'wt-1': tab.groupId }
  })
  mocks.status = 'ready'
  setLocalRuntimeCapabilitiesForTests(null)
  let answer: (status: RuntimeStatus) => void = () => {
    throw new Error('Capability probe did not start')
  }
  const status = new Promise<RuntimeStatus>((resolve) => {
    answer = resolve
  })
  const getStatus = vi.fn(() => status)
  Object.assign(window, { api: { ...window.api, runtime: { getStatus } } })
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        groupId={tab.groupId}
        tabId={tab.id}
        sessionId={tab.entityId}
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
  // An agent that switches in place has the switch control, not the copy-in-a-new-terminal button.
  expect(
    screen.queryAllByRole('button', { name: 'Continue with Terminal Agent', hidden: true })
  ).toHaveLength(0)
  const loadingButtons = screen.getAllByRole('button', { name: 'Switch to CLI', hidden: true })
  for (const button of loadingButtons) {
    expect(button.hasAttribute('disabled')).toBe(true)
  }
  const response = createCompatibleRuntimeStatusResponse('local')
  if (!response.ok) {
    throw new Error('Expected status fixture')
  }
  await act(async () => {
    answer({
      ...response.result,
      capabilities: [inPlaceSwitchCapability('codex')]
    })
    await status
  })
  const buttons = screen.getAllByRole('button', { name: 'Switch to CLI', hidden: true })
  for (const button of buttons) {
    expect(button.hasAttribute('disabled')).toBe(false)
  }
})
