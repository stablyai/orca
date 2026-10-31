// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
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
import { useDesktopVisibleGroups } from './use-desktop-tab-projection'
import { useThreadNavigation } from './thread-navigation'
import { useDesktopThreadPage } from './use-desktop-thread-page'
import {
  isBrowserPageMountAdmitted,
  releaseBrowserPageMount
} from '../browser-pane/host-guest/browser-page-mount-admission'
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

it('draws a delayed browser open without superseding newer explicit conversation navigation', async () => {
  classify(first)
  classify(second)
  render(<Desktop />)
  let browser: ReturnType<ReturnType<typeof useAppStore.getState>['createBrowserTab']>
  act(() => {
    browser = useAppStore.getState().createBrowserTab(W, 'https://example.com', {
      validateLinkPlacement: () => {},
      focusAddressBar: false
    })
    selectThread(second)
  })
  await act(async () => main.settle())
  expect(visibleConversation()).toEqual(['second'])
  expect(useAppStore.getState().tabBarOrderByWorktree[W]).toContain(browser!.id)
  expect(isBrowserPageMountAdmitted(browser!.activePageId!)).toBe(true)
  releaseBrowserPageMount(browser!.activePageId!)
})

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

it.each(['draft', 'empty'] as const)(
  'newer flag-off cycle supersedes retained %s through Settings and the rendered page',
  (kind) => {
    classify(first)
    classify(second)
    useAppStore.setState({
      unifiedTabsByWorktree: { [W]: [first, second] },
      groupsByWorktree: {
        [W]: [
          makeTabGroup({
            id: 'g',
            worktreeId: W,
            activeTabId: first.id,
            tabOrder: [first.id, second.id]
          })
        ]
      }
    })
    if (kind === 'draft') {
      useThreadNavigation.setState({
        selection: { kind: 'new', projectKey: 'local|repo', draftId: 'retained' }
      })
    } else {
      activateAndRevealWorktree(W, { executionHostId: 'local', navigationIntent: 'user-open' })
    }
    render(<Desktop />)
    act(() => useAppStore.getState().openSettingsPage())
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
      })
    )
    act(() => useAppStore.getState().closeSettingsPage())
    act(() => handleSwitchTabAcrossAllTypes(1))
    expect(useAppStore.getState().getActiveTab(W)?.id).toBe(second.id)
    act(() => useAppStore.getState().openSettingsPage())
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: true }
      })
    )
    act(() => useAppStore.getState().closeSettingsPage())
    expect(visibleConversation()).toEqual([second.entityId])
    expect(screen.queryByTestId('strip-g')).toBeNull()
  }
)

it.each(['same-id', 'number', 'palette'] as const)(
  'explicit %s navigation supersedes a draft even with the flag on',
  async (entry) => {
    classify(first)
    useThreadNavigation.setState({
      selection: { kind: 'new', projectKey: 'local|repo', draftId: 'retained' }
    })
    render(<Desktop />)
    if (entry === 'palette') {
      const editor = { ...ordinary, id: 'editor', entityId: 'file', contentType: 'editor' as const }
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: { [W]: [ordinary, first, second, editor] },
          openFiles: [
            {
              id: 'file',
              worktreeId: W,
              filePath: '/main/file',
              relativePath: 'file',
              language: 'text',
              isDirty: false
            }
          ]
        })
      )
      const { activateWorkspaceTabPaletteResult } =
        await import('@/lib/workspace-tab-palette-activation')
      act(() =>
        expect(
          activateWorkspaceTabPaletteResult({
            worktreeId: W,
            executionHostId: 'local',
            groupId: 'g',
            tabId: editor.id,
            entityId: 'file',
            contentType: 'editor'
          }).status
        ).toBe('activated')
      )
      expect(screen.getByTestId('strip-g').dataset.active).toBe(editor.id)
    } else if (entry === 'number') {
      const { activateTabNumberShortcut } = await import('@/lib/tab-number-shortcuts')
      act(() => expect(activateTabNumberShortcut(1)).toBe(true))
      expect(visibleConversation()).toEqual([first.entityId])
    } else {
      act(() => useAppStore.getState().activateTab(first.id, { worktreeId: W }))
      expect(visibleConversation()).toEqual([first.entityId])
    }
    expect(screen.queryByText('Draft retained')).toBeNull()
    expect(useThreadNavigation.getState().selection).toBeNull()
  }
)

it('plain Settings/flag roundtrip and non-user layout activation retain draft intent', () => {
  useThreadNavigation.setState({
    selection: { kind: 'new', projectKey: 'local|repo', draftId: 'retained' }
  })
  render(<Desktop />)
  act(() => useAppStore.getState().openSettingsPage())
  act(() =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
    })
  )
  act(() => useAppStore.getState().activateTab(second.id, { worktreeId: W, recordFocus: false }))
  act(() =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, experimentalThreads: true }
    })
  )
  act(() => useAppStore.getState().closeSettingsPage())
  expect(screen.getByText('Draft retained')).toBeTruthy()
})

it.each([20, 200])(
  'admits the always-mounted page hook inputs before discovering %i groups',
  (count) => {
    const groups = Array.from({ length: count }, (_, i) =>
      makeTabGroup({ id: `g${i}`, worktreeId: W, activeTabId: first.id, tabOrder: [first.id] })
    )
    useAppStore.setState({
      groupsByWorktree: { [W]: groups },
      activeGroupIdByWorktree: { [W]: groups.at(-1)!.id }
    })
    let predicates = 0
    const findGroup = Array.prototype.find
    const find = vi.spyOn(groups, 'find').mockImplementation((predicate) =>
      findGroup.call(groups, (group, i) => {
        predicates++
        return predicate(group, i, groups)
      })
    )
    function PageObserver() {
      const page = useDesktopThreadPage()
      return (
        <output data-testid="page-hook">
          {page?.kind === 'thread' ? page.tabId : (page?.kind ?? 'host')}
        </output>
      )
    }
    render(<PageObserver />)
    expect(predicates).toBeGreaterThanOrEqual(count)
    expect(predicates).toBeLessThanOrEqual(3 * count)
    for (const enabled of [false, true]) {
      act(() =>
        useAppStore.setState({
          settings: { ...useAppStore.getState().settings!, experimentalThreads: enabled }
        })
      )
      for (const intent of [
        null,
        { kind: 'new' as const, projectKey: 'local|repo', draftId: 'retained' }
      ]) {
        act(() => useThreadNavigation.setState({ selection: intent }))
        find.mockClear()
        predicates = 0
        for (const value of ['one', 'two', 'three']) {
          act(() => useAppStore.setState({ settingsSearchQuery: value }))
        }
        expect(find).not.toHaveBeenCalled()
        expect(predicates).toBe(0)
      }
    }
    act(() => useThreadNavigation.setState({ selection: null }))
    act(() => classify(first))
    expect(screen.getByTestId('page-hook').textContent).toBe(first.entityId)
    predicates = 0
    act(() => useAppStore.getState().focusGroup(W, groups[0].id))
    expect(screen.getByTestId('page-hook').textContent).toBe(first.entityId)
    expect(predicates).toBeGreaterThan(0)
    expect(predicates).toBeLessThanOrEqual(3 * count)
    find.mockRestore()
  }
)

it.each([20, 200])(
  'projects %i hidden MRU entries with linear indexed validity and unchanged policy',
  (count) => {
    const hiddenTabs = Array.from({ length: count }, (_, i) => ({
      ...first,
      id: `hidden-${i}`,
      entityId: `session-${i}`
    }))
    hiddenTabs.forEach((tab) => classify(tab))
    const ids = hiddenTabs.map((tab) => tab.id)
    let projection: readonly TabGroup[] = []
    function Fallback({ groups, enabled }: { groups: TabGroup[]; enabled: boolean }) {
      projection = useDesktopVisibleGroups(W, groups, enabled)
      return <output>{projection[0].activeTabId ?? 'empty'}</output>
    }
    for (const ordinaryVisible of [false, true]) {
      const order = [...ids, ...(ordinaryVisible ? [ordinary.id] : [])]
      const recent = ['stale', ...ids, ...(ordinaryVisible ? [ordinary.id] : [])]
      const group = makeTabGroup({
        worktreeId: W,
        activeTabId: ids[0],
        tabOrder: order,
        recentTabIds: recent
      })
      let indexed = 0,
        visited = 0
      const iterator = Array.prototype[Symbol.iterator]
      const index = vi.spyOn(order, Symbol.iterator).mockImplementation(function* () {
        for (const id of iterator.call(order)) {
          indexed++
          yield id
        }
      })
      const find = Array.prototype.find
      const candidates = vi.spyOn(recent, 'find').mockImplementation((predicate) =>
        find.call(recent, (id, i) => {
          visited++
          return predicate(id, i, recent)
        })
      )
      const includes = vi.spyOn(order, 'includes')
      const view = render(<Fallback groups={[group]} enabled />)
      expect(screen.getByText(ordinaryVisible ? ordinary.id : 'empty')).toBeTruthy()
      expect(indexed).toBe(order.length)
      expect(visited).toBe(recent.length)
      expect(includes).not.toHaveBeenCalled()
      view.rerender(<Fallback groups={[group]} enabled={false} />)
      expect(projection[0]).toBe(group)
      expect(screen.getByText(ids[0])).toBeTruthy()
      view.unmount()
      index.mockRestore()
      candidates.mockRestore()
      includes.mockRestore()
    }
  }
)
