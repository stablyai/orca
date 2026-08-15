import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_OMP_FORCE_NEW_SESSION_ENV,
  ORCA_OMP_FRESH_SESSION_DIR_ENV
} from '../../../shared/omp-fresh-session-env'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  createTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  setAgentStatus: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn()
}))

const store = vi.hoisted(() => ({
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: 'web-runtime'
  },
  projects: [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' as const }
    }
  ],
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  terminalLayoutsByTabId: {},
  allWorktrees: vi.fn(),
  closeTab: mocks.closeTab,
  createTab: mocks.createTab,
  queueTabStartupCommand: mocks.queueTabStartupCommand,
  setActiveTabType: mocks.setActiveTabType,
  setAgentStatus: mocks.setAgentStatus
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: mocks.toastError }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track,
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab paired web runtime launch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createTab.mockReturnValue({ id: 'tab-1' })
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(true)
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    store.activeRepoId = 'repo-1'
    store.activeWorktreeId = 'wt-1'
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: '/repo/worktree',
          displayName: 'main'
        }
      ]
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.terminalLayoutsByTabId = {}
    store.allWorktrees.mockReturnValue(store.worktreesByRepo['repo-1'])
  })

  it('keeps promptless non-env launches on the host agent shorthand', () => {
    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(expect.objectContaining({ tabId: null, pasteDraftAfterLaunch: false }))
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agent: 'claude'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(mocks.queueTabStartupCommand).not.toHaveBeenCalled()
  })

  it('forwards promptless OMP launches as concrete startup data so the one-shot fresh-session env reaches the host', () => {
    const result = launchAgentInNewTab({
      agent: 'omp',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(expect.objectContaining({ tabId: null, pasteDraftAfterLaunch: false }))
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledTimes(1)
    const hostLaunch = mocks.createWebRuntimeSessionTerminal.mock.calls[0]?.[0]
    expect(hostLaunch).toEqual(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        targetGroupId: 'group-1',
        activate: true,
        command: `omp --session-dir "$${ORCA_OMP_FRESH_SESSION_DIR_ENV}"`,
        env: { [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1' },
        launchAgent: 'omp'
      })
    )
    expect(hostLaunch).not.toHaveProperty('agent')
    expect(hostLaunch?.launchConfig).toEqual(expect.objectContaining({ agentCommand: 'omp' }))
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(mocks.queueTabStartupCommand).not.toHaveBeenCalled()
  })
})
