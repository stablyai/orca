import recordedOmpReply from '../../../../main/acp/fixtures/omp-v17-reply-without-thought.jsonl?raw'
import { z } from 'zod'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { agentSessionTabFixture } from './native-chat-workspace-test-fixtures'
import * as cliSwitch from '../tab-bar/native-chat-cli-switch-run'
import { useAppStore } from '@/store'
import { makeTabGroup } from '@/store/slices/store-test-helpers'
import * as cliFork from '../tab-bar/native-chat-cli-fork-run'
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { TabSessionSwitchHoverAction } from '../tab-bar/TabSessionSwitchHoverAction'
import { TabSessionSurfaceSwitchMenuItems } from '../tab-bar/TabSessionSurfaceSwitchMenuItems'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

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
  // A read no retry gets past (damage, a newer Orca's chat) takes the whole pane, even after the
  // transcript loaded: its words alone, and nothing that could only be refused again.

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

it('keeps the recorded OMP reply readable with its CLI switch unavailable', () => {
  const chunk = z.object({
    sessionId: z.string(),
    update: z.object({
      sessionUpdate: z.literal('agent_message_chunk'),
      content: z.object({ type: z.literal('text'), text: z.string() })
    })
  })
  const frames = recordedOmpReply
    .trim()
    .split('\n')
    .map((line) => chunk.safeParse(JSON.parse(line).message.params))
    .flatMap((result) => (result.success ? [result.data] : []))
  const text = frames.map(({ update }) => update.content.text).join('')
  expect(text).toContain('marker recorded')
  const { sessionId } = frames[0]
  const tab = agentSessionTabFixture('omp-capture', 'wt-1', {
    agentSessionAgent: 'omp',
    entityId: sessionId
  })
  mocks.messages = [{ id: 'recorded-omp', role: 'assistant', blocks: [{ type: 'text', text }] }]
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ experimentalNativeChat: true }),
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'recorded', { path: '/repo' })] },
    unifiedTabsByWorktree: { 'wt-1': [tab] }
  })
  const invoke = vi.spyOn(cliSwitch, 'runNativeChatCliSwitch')
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId={tab.id}
      sessionId={tab.entityId}
      target={{ kind: 'local' }}
      agent="omp"
    />,
    { wrapper: TooltipProvider }
  )
  const button = screen.getByRole('button', { name: 'Switch to CLI' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(invoke).not.toHaveBeenCalled()
  expect(mocks.messageListProps?.session).toMatchObject({ sessionId, messages: mocks.messages })
})

it('gates eligible native header hover and menu switches through capability hydration and live Chat UI updates', async () => {
  const tab = agentSessionTabFixture('native-controls', 'wt-1', {
    entityId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
  })
  const nativeChat = { sessionId: tab.entityId, agent: 'codex' as const }
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ experimentalNativeChat: false }),
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
  const switchToCli = vi.spyOn(cliSwitch, 'runNativeChatCliSwitch')
  const forkToCli = vi.spyOn(cliFork, 'runNativeChatCliFork')
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
      <TabSessionSwitchHoverAction tab={tab} nativeChat={nativeChat} />
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open native tab menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabSessionSurfaceSwitchMenuItems tab={tab} nativeChat={nativeChat} leadingSeparator />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const actions = screen
    .getByRole('button', { name: 'Split Chat Right', hidden: true })
    .closest('.pane-title-actions')
  if (!(actions instanceof HTMLElement)) {
    throw new Error('Expected the grouped pane actions row')
  }
  const row = within(actions)
  expect(row.getByRole('button', { name: 'Close tab', hidden: true })).toBeTruthy()
  const transcript = screen.getByTestId('message-list')
  const legacyName = 'Show as terminal'
  const expectHidden = () => {
    expect(screen.queryAllByRole('button', { name: 'Switch to CLI', hidden: true })).toHaveLength(0)
    expect(screen.queryByRole('menuitem', { name: 'Switch to CLI' })).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByText('Resume in New Terminal')).toBeNull()
    expect(screen.getByTestId('message-list')).toBe(transcript)
    expect(screen.getAllByRole('button', { name: legacyName, hidden: true })).toHaveLength(1)
  }
  expect(readLocalRuntimeCapabilitiesOrUnknown()).toBeNull()
  expectHidden()
  act(() => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: true })
    })
  })
  const loadingButtons = screen.getAllByRole('button', { name: 'Switch to CLI', hidden: true })
  expect(loadingButtons).toHaveLength(2)
  expect(row.getAllByRole('button', { name: 'Switch to CLI', hidden: true })).toHaveLength(1)
  for (const button of loadingButtons) {
    expect(button.hasAttribute('disabled')).toBe(true)
  }
  expect(screen.queryByRole('button', { name: legacyName, hidden: true })).toBeNull()
  expect(
    screen.getByRole('menuitem', { name: 'Switch to CLI' }).hasAttribute('data-disabled')
  ).toBe(true)
  const response = createCompatibleRuntimeStatusResponse('local')
  if (!response.ok) {
    throw new Error('Expected status fixture')
  }
  await act(async () => {
    answer({ ...response.result, capabilities: ['agent-session.structured.switch.v1:codex'] })
    await status
  })
  expect(readLocalRuntimeCapabilitiesOrUnknown()).toContain(
    'agent-session.structured.switch.v1:codex'
  )
  const buttons = screen.getAllByRole('button', { name: 'Switch to CLI', hidden: true })
  expect(buttons).toHaveLength(2)
  expect(row.getAllByRole('button', { name: 'Switch to CLI', hidden: true })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: legacyName, hidden: true })).toBeNull()
  for (const button of buttons) {
    expect(button.hasAttribute('disabled')).toBe(false)
  }
  expect(
    screen.getByRole('menuitem', { name: 'Switch to CLI' }).getAttribute('data-disabled')
  ).toBeNull()
  act(() => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: false })
    })
  })
  expectHidden()
  act(() => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: true })
    })
  })
  getStatus.mockResolvedValue({ ...response.result, capabilities: [] })
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  expect(screen.queryAllByRole('button', { name: 'Switch to CLI', hidden: true })).toHaveLength(0)
  expect(screen.queryByRole('menuitem', { name: 'Switch to CLI' })).toBeNull()
  expect(screen.getAllByRole('button', { name: legacyName, hidden: true })).toHaveLength(1)
  expect(screen.getByRole('menuitem', { name: 'Resume in New Terminal' })).toBeTruthy()
  expect(screen.getByRole('separator')).toBeTruthy()
  expect(screen.getByTestId('message-list')).toBe(transcript)
  expect(readLocalRuntimeCapabilitiesOrUnknown()).toEqual([])
  expect(getStatus).toHaveBeenCalledTimes(2)
  expect(forkToCli).not.toHaveBeenCalled()
  expect(switchToCli).not.toHaveBeenCalled()
})
