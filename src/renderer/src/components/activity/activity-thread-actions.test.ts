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

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateStructuredAgentSessionTab.mockReturnValue(false)
    getKnownWorktreeById.mockReturnValue(thread.worktree)
    mocks.getState.mockReturnValue({
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
    })
  })

  it('selects the matching host when the same workspace id is active elsewhere', () => {
    const actions = createActivityThreadActions({
      getMarkAllReadThreads: () => [thread],
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey
    })

    actions.selectThread(thread)

    expect(getKnownWorktreeById).toHaveBeenCalledWith(thread.worktree.id, REMOTE_HOST)
    expect(setActiveWorktree).toHaveBeenCalledWith(thread.worktree.id, REMOTE_HOST)
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
      thread.tab.id,
      '11111111-1111-4111-8111-111111111111',
      { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
    )
  })

  it('activates a structured agent session instead of looking for a terminal pane', () => {
    mocks.activateStructuredAgentSessionTab.mockReturnValue(true)
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      tabsByWorktree: { [thread.worktree.id]: [] },
      unifiedTabsByWorktree: {
        [thread.worktree.id]: [{ id: thread.tab.id, contentType: 'agent-session' }]
      }
    })
    const actions = createActivityThreadActions({
      getMarkAllReadThreads: () => [thread],
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey
    })

    actions.selectThread(thread)

    expect(mocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: thread.worktree.id,
      tabId: thread.tab.id
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('jumps to and probes the matching host-qualified workspace', () => {
    expect(hasActivityThreadWorkspace(thread)).toBe(true)
    const actions = createActivityThreadActions({
      getMarkAllReadThreads: () => [thread],
      acknowledgeAgents,
      unacknowledgeAgents: vi.fn(),
      setSelectedPaneKey
    })

    actions.jumpToWorkspace(thread)

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
