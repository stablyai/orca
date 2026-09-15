import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import type { AgentPaneThread } from './activity-thread-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateStructuredAgentSessionTab: vi.fn(),
  activateAndRevealWorkspace: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.activateStructuredAgentSessionTab
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))

import { createActivityThreadActions, hasActivityThreadWorkspace } from './activity-thread-actions'

const REMOTE_HOST = 'ssh:devbox' as const

function makeRemoteThread(): AgentPaneThread {
  const worktree = { ...makeWorktree(), hostId: REMOTE_HOST }
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    paneTitle: 'Remote agent',
    agentType: 'claude',
    worktree,
    repo: makeRepo(),
    tab: makeTab(),
    events: [],
    latestEvent: null,
    latestTimestamp: 1_000,
    currentAgentState: 'working',
    currentAgentEntry: null,
    unread: true,
    responsePreview: ''
  }
}

describe('activity thread host routing', () => {
  const thread = makeRemoteThread()
  const getKnownWorktreeById = vi.fn()
  const setActiveWorktree = vi.fn()
  const acknowledgeAgents = vi.fn()
  const setSelectedPaneKey = vi.fn()
  let state: Record<string, unknown>

  function makeActions(): ReturnType<typeof createActivityThreadActions> {
    return createActivityThreadActions({
      getMarkAllReadThreads: () => [thread],
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateStructuredAgentSessionTab.mockReturnValue(false)
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    getKnownWorktreeById.mockReturnValue(thread.worktree)
    state = {
      getKnownWorktreeById,
      worktreesByRepo: { [thread.worktree.repoId]: [thread.worktree] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      showSleepingWorkspaces: true,
      filterRepoIds: [],
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      alwaysShowDefaultBranchWorkspace: true,
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all',
      tabsByWorktree: { [thread.worktree.id]: [thread.tab] },
      unifiedTabsByWorktree: {},
      unreadAgentCompletionPanes: {},
      unreadTerminalTabs: {},
      clearWorktreeUnread: vi.fn(),
      activeRepoId: thread.worktree.repoId,
      activeWorktreeId: thread.worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      setActiveRepo: vi.fn(),
      setActiveWorktree,
      setActiveTabType: vi.fn()
    }
    mocks.getState.mockImplementation(() => state)
  })

  it('routes the row click through the full activation sequence for the matching host', () => {
    makeActions().selectThread(thread)

    // Bare setActiveWorktree skips setActiveView('terminal'), initial-terminal seeding and
    // sleeping-session resume — the workspace dispatcher is the only path that runs them.
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith(thread.worktree.id, {
      executionHostId: REMOTE_HOST,
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
      thread.tab.id,
      '11111111-1111-4111-8111-111111111111',
      { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
    )
  })

  it('opens a cold-parked remote thread whose tab activation revives', () => {
    // The reported SSH symptom: the tab is not resident because the session was never
    // revived, so a residency probe before activation made the click a silent no-op.
    state.tabsByWorktree = {}
    mocks.activateAndRevealWorkspace.mockImplementation(() => {
      state.tabsByWorktree = { [thread.worktree.id]: [thread.tab] }
      return { primaryTabId: thread.tab.id }
    })

    makeActions().selectThread(thread)

    expect(setSelectedPaneKey).toHaveBeenCalledWith(thread.paneKey)
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith(thread.worktree.id, {
      executionHostId: REMOTE_HOST,
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
      thread.tab.id,
      '11111111-1111-4111-8111-111111111111',
      { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
    )
  })

  it('still activates the workspace when a retained thread has no tab to focus', () => {
    state.tabsByWorktree = {}

    makeActions().selectThread(thread)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith(thread.worktree.id, {
      executionHostId: REMOTE_HOST,
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('focuses nothing when the workspace itself is gone', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)

    makeActions().selectThread(thread)

    expect(mocks.activateStructuredAgentSessionTab).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('activates a structured agent session instead of looking for a terminal pane', () => {
    mocks.activateStructuredAgentSessionTab.mockReturnValue(true)
    state.tabsByWorktree = { [thread.worktree.id]: [] }
    state.unifiedTabsByWorktree = {
      [thread.worktree.id]: [{ id: thread.tab.id, contentType: 'agent-session' }]
    }

    makeActions().selectThread(thread)

    expect(mocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: thread.worktree.id,
      tabId: thread.tab.id
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('jumps to and probes the matching host-qualified workspace', () => {
    expect(hasActivityThreadWorkspace(thread)).toBe(true)

    makeActions().jumpToWorkspace(thread)

    expect(acknowledgeAgents).toHaveBeenCalledWith([thread.paneKey])
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith(thread.worktree.id, {
      executionHostId: REMOTE_HOST
    })
  })

  it('marks all unread threads in the mark-all set, reading it at call time', () => {
    const readThread = { ...makeRemoteThread(), paneKey: 'tab-2:read', unread: false }
    let markAllSet = [readThread]
    const actions = createActivityThreadActions({
      getMarkAllReadThreads: () => markAllSet,
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey
    })

    actions.markAllThreadsRead()
    expect(acknowledgeAgents).not.toHaveBeenCalled()

    // The handler keeps one identity while the set changes underneath it.
    markAllSet = [thread, readThread]
    actions.markAllThreadsRead()
    expect(acknowledgeAgents).toHaveBeenCalledWith([thread.paneKey])
  })
})

describe('worktree unread cleanup after acknowledging panes', () => {
  const thread = makeRemoteThread()
  // A second unread completion in the same worktree, outside the mark-all set.
  const siblingPaneKey = 'tab-1:22222222-2222-4222-8222-222222222222'
  const clearWorktreeUnread = vi.fn()
  let state: {
    worktreesByRepo: Record<string, unknown[]>
    detectedWorktreesByRepo: Record<string, unknown[]>
    folderWorkspaces: unknown[]
    showSleepingWorkspaces: boolean
    filterRepoIds: unknown[]
    hideDefaultBranchWorkspace: boolean
    hideAutomationGeneratedWorkspaces: boolean
    hideCliCreatedWorkspaces: boolean
    hideDetachedHeadWorkspaces: boolean
    hideWorkspacesFromOtherDevices: boolean
    alwaysShowDefaultBranchWorkspace: boolean
    visibleWorkspaceHostIds: unknown
    workspaceHostScope: string
    tabsByWorktree: Record<string, Array<{ id: string }>>
    unreadAgentCompletionPanes: Record<string, true>
    unreadTerminalTabs: Record<string, true>
    clearWorktreeUnread: typeof clearWorktreeUnread
  }
  // Stateful: the real ack reducer drops the pane from unreadAgentCompletionPanes, so the
  // post-ack getState() read in clearWorktreeUnreadIfNoOtherAttention sees it gone — a
  // non-mutating mock would leave the pane in place and make these assertions vacuous.
  const acknowledgeAgents = vi.fn((paneKeys: string[]) => {
    for (const key of paneKeys) {
      delete state.unreadAgentCompletionPanes[key]
    }
  })

  function makeActions(markAllThreads: AgentPaneThread[] = [thread]) {
    return createActivityThreadActions({
      getMarkAllReadThreads: () => markAllThreads,
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey: vi.fn()
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state = {
      worktreesByRepo: { [thread.worktree.repoId]: [thread.worktree] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      showSleepingWorkspaces: true,
      filterRepoIds: [],
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      alwaysShowDefaultBranchWorkspace: true,
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all',
      tabsByWorktree: { [thread.worktree.id]: [thread.tab] },
      unreadAgentCompletionPanes: { [thread.paneKey]: true },
      unreadTerminalTabs: {},
      clearWorktreeUnread
    }
    mocks.getState.mockImplementation(() => state)
  })

  it('markThreadRead clears the worktree flag when the pane was the last unread completion', () => {
    makeActions().markThreadRead(thread)

    expect(acknowledgeAgents).toHaveBeenCalledWith([thread.paneKey])
    expect(clearWorktreeUnread).toHaveBeenCalledWith(thread.worktree.id)
  })

  it('markThreadRead preserves the worktree flag when another unread agent pane remains', () => {
    state.unreadAgentCompletionPanes[siblingPaneKey] = true

    makeActions().markThreadRead(thread)

    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('markThreadRead preserves the worktree flag when an unread terminal tab remains', () => {
    state.unreadTerminalTabs[thread.tab.id] = true

    makeActions().markThreadRead(thread)

    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('markAllThreadsRead clears the worktree flag when the acknowledged panes were the last unread', () => {
    makeActions().markAllThreadsRead()

    expect(acknowledgeAgents).toHaveBeenCalledWith([thread.paneKey])
    expect(clearWorktreeUnread).toHaveBeenCalledWith(thread.worktree.id)
  })

  it('markAllThreadsRead preserves the worktree flag when an unread pane remains outside the mark-all set', () => {
    state.unreadAgentCompletionPanes[siblingPaneKey] = true

    makeActions().markAllThreadsRead()

    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('markAllThreadsRead preserves the worktree flag when an unread terminal tab remains', () => {
    state.unreadTerminalTabs[thread.tab.id] = true

    makeActions().markAllThreadsRead()

    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('automatic acknowledgment on jump clears the worktree flag for the last unread pane', () => {
    makeActions().jumpToWorkspace(thread)

    expect(acknowledgeAgents).toHaveBeenCalledWith([thread.paneKey])
    expect(clearWorktreeUnread).toHaveBeenCalledWith(thread.worktree.id)
  })

  it('automatic acknowledgment on jump preserves the worktree flag when another unread pane remains', () => {
    state.unreadAgentCompletionPanes[siblingPaneKey] = true

    makeActions().jumpToWorkspace(thread)

    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })
})
