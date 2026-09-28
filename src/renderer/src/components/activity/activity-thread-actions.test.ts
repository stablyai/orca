import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import type { AgentPaneThread } from './activity-thread-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateStructuredAgentSessionTab: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  isFloatingWorkspacePanelVisible: vi.fn(),
  dispatchEvent: vi.fn()
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
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelVisible: mocks.isFloatingWorkspacePanelVisible
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
    vi.stubGlobal('window', { dispatchEvent: mocks.dispatchEvent })
    mocks.isFloatingWorkspacePanelVisible.mockReturnValue(false)
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
      activeRepoId: thread.worktree.repoId,
      activeWorktreeId: thread.worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      setActiveRepo: vi.fn(),
      setActiveWorktree,
      setActiveTabType: vi.fn()
    }
    mocks.getState.mockImplementation(() => state)
  })

  afterEach(() => vi.unstubAllGlobals())

  function makeFloatingThread(): AgentPaneThread {
    return {
      ...thread,
      worktree: { ...thread.worktree, id: FLOATING_TERMINAL_WORKTREE_ID },
      repo: null,
      tab: { ...thread.tab, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    }
  }

  it.each([false, true])(
    'reveals the floating agent pane when the panel is open=%s without switching workspace',
    (open) => {
      const floatingThread = makeFloatingThread()
      state.settings = { floatingTerminalEnabled: true }
      state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingThread.tab] }
      mocks.activateAndRevealWorkspace.mockReturnValue(false)
      mocks.isFloatingWorkspacePanelVisible.mockReturnValue(open)

      makeActions().selectThread(floatingThread)

      expect(setSelectedPaneKey).toHaveBeenCalledWith(floatingThread.paneKey)
      expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
      expect(setActiveWorktree).not.toHaveBeenCalled()
      expect(mocks.dispatchEvent).toHaveBeenCalledTimes(open ? 0 : 1)
      if (!open) {
        expect(mocks.dispatchEvent).toHaveBeenCalledWith(
          expect.objectContaining({ type: TOGGLE_FLOATING_TERMINAL_EVENT })
        )
      }
      expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
        floatingThread.tab.id,
        '11111111-1111-4111-8111-111111111111',
        { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
      )
    }
  )

  it('enables a disabled floating workspace before revealing its agent pane', async () => {
    const floatingThread = makeFloatingThread()
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    state.settings = { floatingTerminalEnabled: false }
    state.updateSettings = updateSettings
    state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingThread.tab] }

    makeActions().selectThread(floatingThread)

    expect(updateSettings).toHaveBeenCalledWith({ floatingTerminalEnabled: true })
    expect(mocks.dispatchEvent).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalled()
    await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1))
    expect(mocks.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: TOGGLE_FLOATING_TERMINAL_EVENT })
    )
  })

  it('does not open the floating panel for a retained thread whose tab was closed', () => {
    makeActions().selectThread(makeFloatingThread())

    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(mocks.dispatchEvent).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
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
