import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mocks = vi.hoisted(() => ({
  getKnownWorktreeById: vi.fn(),
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  resolveAgentResumeLaunchTarget: vi.fn(() => ({ platform: 'linux', shell: undefined })),
  queueTabStartupCommand: vi.fn(),
  createTab: vi.fn(() => ({ id: 'resumed-tab' })),
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentResumeStartupPlan: () => ({ launchCommand: "claude '--resume' 'session-1'" })
}))
vi.mock('@/lib/telemetry', () => ({ tuiAgentToAgentKind: () => 'claude' }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: () => [] }))
vi.mock('@/lib/agent-resume-launch-target', () => ({
  resolveAgentResumeLaunchTarget: mocks.resolveAgentResumeLaunchTarget
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: mocks.getLocalProjectExecutionRuntimeContext
}))
vi.mock('../../../shared/tui-agent-launch-defaults', () => ({
  resolveTuiAgentLaunchArgs: () => '',
  resolveTuiAgentLaunchEnv: () => ({})
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')

const record: SleepingAgentSessionRecord = {
  paneKey: 'closed-tab:leaf-1',
  tabId: 'closed-tab',
  worktreeId: 'colliding-worktree',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: 'finish',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1,
  connectionId: 'remote-connection'
}

describe('sleeping agent resume host collision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getKnownWorktreeById.mockReturnValue({
      id: record.worktreeId,
      repoId: 'repo-1',
      path: '/remote/worktree'
    })
    mocks.state = {
      getKnownWorktreeById: mocks.getKnownWorktreeById,
      repos: [
        { id: 'repo-1', path: 'C:\\local', executionHostId: 'local' },
        {
          id: 'repo-1',
          path: '/remote',
          connectionId: 'remote-connection',
          executionHostId: 'ssh:remote-connection'
        }
      ],
      settings: { agentCmdOverrides: {} },
      tabsByWorktree: { [record.worktreeId]: [] },
      openFiles: [],
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {},
      createTab: mocks.createTab,
      queueTabStartupCommand: mocks.queueTabStartupCommand,
      claimAutomaticAgentResume: vi.fn(),
      clearSleepingAgentSession: vi.fn(),
      setActiveTabType: vi.fn(),
      setTabBarOrder: vi.fn()
    }
  })

  it('does not let a colliding local WSL project override an SSH resume target', () => {
    expect(launchSleepingAgentSession(record, { executionHostId: 'ssh:remote-connection' })).toBe(
      true
    )

    expect(mocks.getKnownWorktreeById).toHaveBeenCalledWith(
      record.worktreeId,
      'ssh:remote-connection'
    )
    expect(mocks.getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(mocks.resolveAgentResumeLaunchTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRuntime: undefined,
        connectionId: 'remote-connection',
        executionHostId: 'ssh:remote-connection',
        worktreePath: '/remote/worktree'
      })
    )
  })
})
