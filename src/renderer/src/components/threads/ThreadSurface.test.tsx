// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'

vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('../native-chat/NativeChatView', () => ({
  default: ({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) => (
    <div data-testid="conversation" hidden={!isVisible}>
      {sessionId}
    </div>
  )
}))
vi.mock('./NewThread', () => ({
  NewThread: ({ draftId }: { draftId: string }) => <div>Draft {draftId}</div>
}))
import { useAppStore } from '@/store'
import { makeWorktree, makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
import { TooltipProvider } from '../ui/tooltip'
import { ThreadsSection } from './ThreadsSection'
import { ThreadSurface, useThreadSurfaceActive } from './ThreadSurface'
import { useThreadNavigation } from './thread-navigation'
import {
  publishStructuredSessionSummaries,
  useStructuredSessionSummaries
} from '../native-chat/structured-session-summary-store'
import StructuredAgentSessionPaneOverlayLayer from '../native-chat/StructuredAgentSessionPaneOverlayLayer'
import { useTabGroupItemProjections } from '../tab-group/useTabGroupItemProjections'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { makeTab as makeActivityTab } from '../activity/ActivityPrototypePage-test-fixtures'
import { createActivityThreadActions } from '../activity/activity-thread-actions'
import { registerTerminalUiRoutingIpcBridge } from '@/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import { handleSwitchTabAcrossAllTypes, handleSwitchRecentTab } from '@/hooks/ipc-tab-switch'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'
import { selectThread } from './thread-actions'

const W = 'repo::/main'
const ordinary = makeUnifiedTab({
  id: 'ordinary',
  entityId: 'ordinary',
  worktreeId: W,
  groupId: 'g',
  contentType: 'agent-session',
  executionHostId: 'local',
  agentSessionAgent: 'codex'
})
const first = { ...ordinary, id: 'first', entityId: 'first' }
const second = { ...ordinary, id: 'second', entityId: 'second' }
const repo = { id: 'repo', path: '/main', displayName: 'Project', addedAt: 1, badgeColor: '' }
const worktree = makeWorktree({
  id: W,
  repoId: 'repo',
  path: '/main',
  isMainWorktree: true,
  hostId: 'local'
})
function classify(tab: Tab, changes: Partial<AgentSessionStatusSummary> = {}) {
  publishStructuredSessionSummaries([
    {
      tabId: tab.id,
      tab,
      summary: {
        sessionId: tab.entityId,
        workspaceId: W,
        agent: 'codex',
        status: 'idle',
        latestPrompt: tab.id,
        updatedAt: 1,
        surface: 'thread',
        ...changes
      }
    }
  ])
}
function Workbench() {
  const id = useAppStore((s) => s.activeWorktreeId) ?? W
  const groups = useAppStore((s) => s.groupsByWorktree[id]) ?? []
  return (
    <>
      {groups.map((group) => (
        <Strip key={group.id} id={id} groupId={group.id} />
      ))}
      <StructuredAgentSessionPaneOverlayLayer worktreeId={id} isWorktreeActive />
    </>
  )
}
function Strip({ id, groupId }: { id: string; groupId: string }) {
  const groups = useAppStore((s) => s.groupsByWorktree[id])
  const unifiedTabs = useAppStore((s) => s.unifiedTabsByWorktree[id])
  const threadsEnabled = useAppStore((s) => s.settings?.experimentalThreads === true)
  const { groupTabs, activeTab } = useTabGroupItemProjections({
    groupId,
    worktreeId: id,
    worktreeState: {
      groups: groups ?? [],
      unifiedTabs: unifiedTabs ?? [],
      terminalTabs: [],
      openFiles: [],
      browserTabs: [],
      expandedPaneByTabId: {},
      terminalLayoutsByTabId: {},
      threadsEnabled,
      generatedTabTitlesEnabled: false,
      mobileEmulatorEnabled: false
    }
  })
  return (
    <div data-testid={`strip-${groupId}`} data-active={activeTab?.id ?? ''}>
      {groupTabs.map((tab) => (
        <span key={tab.id}>{tab.id}</span>
      ))}
      {!activeTab ? 'Empty workbench' : null}
    </div>
  )
}
function Desktop() {
  const thread = useThreadSurfaceActive()
  const view = useAppStore((s) => s.activeView)
  return (
    <TooltipProvider>
      {view !== 'terminal' ? <div>Settings</div> : thread ? <ThreadSurface /> : <Workbench />}
    </TooltipProvider>
  )
}
function visibleConversation() {
  return screen
    .queryAllByTestId('conversation')
    .filter((node) => !node.hidden && !node.closest('[aria-hidden="true"]'))
    .map((node) => node.textContent)
}
let main: TabsDrawnFromMain
beforeEach(async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        call: vi.fn(async () => ({
          id: 'test',
          ok: true,
          result: null,
          _meta: { runtimeId: 'local' }
        }))
      },
      ui: {
        onSplitTerminal: vi.fn(() => () => {}),
        onRenameTerminal: vi.fn(() => () => {}),
        onFocusTerminal: vi.fn(() => () => {}),
        onFocusEditorTab: vi.fn(() => () => {})
      }
    }
  })
  useThreadNavigation.setState({ selection: null })
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalThreads: true },
    activeView: 'terminal',
    activeWorktreeId: W,
    activeWorkspaceExecutionHostId: 'local',
    activeRepoId: 'repo',
    repos: [repo],
    worktreesByRepo: { repo: [worktree] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    unifiedTabsByWorktree: { [W]: [ordinary, first, second] },
    groupsByWorktree: {
      [W]: [
        makeTabGroup({
          id: 'g',
          worktreeId: W,
          activeTabId: first.id,
          tabOrder: ['ordinary', 'first', 'second'],
          recentTabIds: ['first', 'ordinary', 'second']
        })
      ]
    },
    activeGroupIdByWorktree: { [W]: 'g' },
    tabsByWorktree: {},
    activeTabType: 'agent-session',
    setActiveTabType: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 3 })),
    revealWorktreeInSidebar: vi.fn()
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => {
  cleanup()
  main.close()
  publishStructuredSessionSummaries(
    [...useStructuredSessionSummaries.getState().threadTabIds].map((tabId) => ({
      tabId,
      summary: null
    }))
  )
})
it('renders the selected session across reload/late summary, flag transitions, Settings, title change and project removal', () => {
  render(<Desktop />)
  expect(visibleConversation()).toEqual(['first'])
  act(() => classify(first))
  expect(visibleConversation()).toEqual(['first'])
  expect(screen.getByText('Project')).toBeTruthy()
  // Desktop-only hiding must not change the phone's ordinary host group inventory.
  const phone = buildMobileSessionTabSnapshots(useAppStore.getState(), false).find(
    (snapshot) => snapshot.worktree === W
  )
  expect(phone?.tabGroups?.[0]).toMatchObject({
    activeTabId: 'agent-session:first',
    tabOrder: ['agent-session:ordinary', 'agent-session:first', 'agent-session:second']
  })
  act(() => useAppStore.setState({ activeView: 'settings' }))
  expect(screen.getByText('Settings')).toBeTruthy()
  act(() => useAppStore.setState({ activeView: 'terminal' }))
  expect(visibleConversation()).toEqual(['first'])
  act(() =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
    })
  )
  expect(screen.getByTestId('strip-g').dataset.active).toBe('first')
  expect(visibleConversation()).toEqual(['first'])
  act(() =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: true }
    })
  )
  act(() => classify(first, { conversationName: 'Renamed conversation' }))
  expect(screen.getByText('Renamed conversation')).toBeTruthy()
  act(() => useAppStore.setState({ unifiedTabsByWorktree: {}, groupsByWorktree: {}, repos: [] }))
  expect(screen.queryByText('Renamed conversation')).toBeNull()
})
it.each(['open', 'closed', 'same-workspace'] as const)(
  'History %s activates its requested conversation through the visible page',
  async (path) => {
    classify(first)
    classify(second)
    if (path !== 'same-workspace') {
      useAppStore.setState({ activeWorktreeId: null })
    }
    if (path === 'closed') {
      useAppStore.setState({ unifiedTabsByWorktree: { [W]: [ordinary, first] } })
    }
    render(<Desktop />)
    await act(async () => {
      await activateAiVaultStructuredSession(
        { structuredSession: { workspaceId: W, sessionId: 'second', agent: 'codex' } },
        {
          activate: activateStructuredAgentSessionById,
          refresh: async () => {},
          reveal: async () => {
            useAppStore.setState({ unifiedTabsByWorktree: { [W]: [ordinary, first, second] } })
            return 'revealed'
          },
          unavailable: vi.fn(),
          gone: vi.fn(),
          hostCannotOpen: vi.fn()
        },
        { kind: 'local' }
      )
    })
    expect(visibleConversation()).toEqual(['second'])
  }
)
it('Agents, sidebar and explicit IPC select the same page; courtesy reveal preserves a draft', async () => {
  classify(first)
  classify(second)
  render(<Desktop />)
  const actions = createActivityThreadActions({
    getMarkAllReadThreads: () => [],
    acknowledgeAgents: vi.fn(),
    unacknowledgeAgents: vi.fn(),
    setSelectedPaneKey: vi.fn()
  })
  act(() =>
    actions.selectThread({
      tab: { ...makeActivityTab(), id: second.id, worktreeId: W },
      worktree,
      repo,
      paneKey: 'second:root',
      paneTitle: 'Second',
      agentType: 'codex',
      currentAgentState: null,
      currentAgentEntry: null,
      responsePreview: '',
      latestTimestamp: 1,
      latestEvent: null,
      events: [],
      unread: false
    })
  )
  expect(visibleConversation()).toEqual(['second'])
  act(() => selectThread(first))
  expect(visibleConversation()).toEqual(['first'])
  const focus = vi.spyOn(window.api.ui, 'onFocusEditorTab')
  const unsubs: (() => void)[] = []
  registerTerminalUiRoutingIpcBridge(unsubs)
  const callback = focus.mock.calls[0][0]
  act(() => callback({ tabId: 'second', worktreeId: W, userInitiated: true }))
  expect(visibleConversation()).toEqual(['second'])
  act(() =>
    useThreadNavigation.setState({
      selection: { kind: 'new', draftId: 'pending', projectKey: 'local|repo' }
    })
  )
  act(() => callback({ tabId: 'first', worktreeId: W, userInitiated: false }))
  expect(screen.getByText('Draft pending')).toBeTruthy()
  act(() => callback({ tabId: 'first', worktreeId: W, userInitiated: true }))
  expect(visibleConversation()).toEqual(['first'])
  unsubs.forEach((unsubscribe) => unsubscribe())
  focus.mockRestore()
})
it('explicit workspace open, cycle and MRU agree with the visible strip, including a thread-only workbench', () => {
  classify(first)
  classify(second)
  render(<Desktop />)
  act(() =>
    activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
  )
  expect(screen.getByTestId('strip-g').dataset.active).toBe('ordinary')
  expect(visibleConversation()).toEqual(['ordinary'])
  act(() => handleSwitchTabAcrossAllTypes(1))
  act(() => handleSwitchRecentTab())
  expect(visibleConversation()).toEqual(['ordinary'])
  expect(useAppStore.getState().unifiedTabsByWorktree[W]).toHaveLength(3)
  act(() => {
    useAppStore.setState({
      unifiedTabsByWorktree: { [W]: [first, second] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: first.id,
            tabOrder: ['first', 'second'],
            recentTabIds: ['first', 'second']
          })
        ]
      }
    })
    activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
  })
  expect(screen.getByText('Empty workbench')).toBeTruthy()
  expect(visibleConversation()).toEqual([])
  const close = vi.spyOn(useAppStore.getState(), 'closeUnifiedTab')
  act(() => dispatchWorkspaceTabCommand({ type: 'close' }))
  expect(close).not.toHaveBeenCalled()
})

it('derives split selection and a close-next empty workbench from the same visible group projection', async () => {
  classify(first)
  classify(second)
  const groupedSecond = { ...second, groupId: 'split' }
  useAppStore.setState({
    unifiedTabsByWorktree: { [W]: [ordinary, first, groupedSecond] },
    groupsByWorktree: {
      [W]: [
        makeTabGroup({
          id: 'g',
          worktreeId: W,
          activeTabId: first.id,
          tabOrder: ['ordinary', 'first'],
          recentTabIds: ['first', 'ordinary']
        }),
        makeTabGroup({ id: 'split', worktreeId: W, activeTabId: second.id, tabOrder: ['second'] })
      ]
    }
  })
  render(<Desktop />)
  act(() => useAppStore.getState().focusGroup(W, 'split'))
  expect(visibleConversation()).toEqual(['second'])
  act(() =>
    activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
  )
  expect(screen.getByTestId('strip-split').dataset.active).toBe('')
  expect(visibleConversation()).toEqual(['ordinary'])
  act(() => {
    useAppStore.getState().focusGroup(W, 'g')
    activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
  })
  await act(async () => {
    useAppStore.getState().closeUnifiedTab(ordinary.id)
    await main.settle()
  })
  expect(screen.getByTestId('strip-g').dataset.active).toBe('')
  expect(visibleConversation()).toEqual([])
  expect(useAppStore.getState().unifiedTabsByWorktree[W].map((t) => t.id)).toEqual([
    'first',
    'second'
  ])
})
it.each([20, 200])(
  'does no selected-tab population scan on unrelated writes with %i retained tabs',
  (count) => {
    const tabs = [
      first,
      ...Array.from({ length: count }, (_, i) => ({ ...ordinary, id: `extra-${i}` }))
    ]
    useAppStore.setState({ unifiedTabsByWorktree: { [W]: tabs } })
    classify(first)
    render(<Desktop />)
    const find = vi.spyOn(tabs, 'find')
    for (let i = 0; i < 3; i++) {
      act(() => useAppStore.setState({ activeRepoId: `unrelated-${i}` }))
    }
    expect(find).not.toHaveBeenCalled()
    expect(visibleConversation()).toEqual(['first'])
    find.mockRestore()
  }
)

it('the rendered Threads row activates and labels the same conversation as the page', () => {
  classify(first)
  classify(second)
  render(
    <TooltipProvider>
      <ThreadsSection />
      <Desktop />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: /first/ }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(screen.getByRole('button', { name: /second/ }))
  expect(visibleConversation()).toEqual(['second'])
  expect(screen.getByRole('button', { name: /second/ }).getAttribute('aria-current')).toBe('page')
  act(() => classify(second, { conversationName: 'Chosen conversation' }))
  expect(screen.getByRole('button', { name: /Chosen conversation/ })).toBeTruthy()
  expect(screen.getAllByText('Chosen conversation')).toHaveLength(2)
})
