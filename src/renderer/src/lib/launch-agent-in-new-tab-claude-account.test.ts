import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import type { launchAgentInWebHostTab } from './launch-agent-web-host-tab'

const mockQueueTabStartupCommand = vi.fn()
const { mockIsWebRuntimeSessionActive, mockLaunchAgentInWebHostTab } = vi.hoisted(() => ({
  mockIsWebRuntimeSessionActive: vi.fn(() => false),
  mockLaunchAgentInWebHostTab: vi.fn((_args: Parameters<typeof launchAgentInWebHostTab>[0]) =>
    Promise.resolve({ delivered: false, failureNotified: false })
  )
}))

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null
  },
  repos: [
    {
      id: 'repo-1',
      path: '/repo',
      connectionId: null,
      agentAccounts: { claude: { mode: 'account' as const, accountId: 'acct-1' } }
    }
  ],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'repo-1::/repo/wt': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))

vi.mock('@/lib/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))

function queuedLaunchConfig(): unknown {
  return mockQueueTabStartupCommand.mock.calls[0]?.[1]?.launchConfig
}

describe('launchAgentInNewTab Claude account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
  })

  it("stamps the project's saved account on a Claude launch", async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'repo-1::/repo/wt' })

    expect(queuedLaunchConfig()).toEqual(expect.objectContaining({ claudeAccountId: 'acct-1' }))
  })

  it('prefers a one-time account choice over the saved one', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'repo-1::/repo/wt',
      claudeAccountId: 'acct-2'
    })

    expect(queuedLaunchConfig()).toEqual(expect.objectContaining({ claudeAccountId: 'acct-2' }))
  })

  it('leaves other agents unstamped', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'repo-1::/repo/wt' })

    expect(queuedLaunchConfig()).not.toHaveProperty('claudeAccountId')
  })

  it('stamps a paired web-host launch and relaunches it on the active account', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const webLaunch = () => mockLaunchAgentInWebHostTab.mock.calls.at(-1)![0]

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'repo-1::/repo/wt',
      claudeAccountId: 'acct-2'
    })
    expect(webLaunch().startupPlan.launchConfig.claudeAccountId).toBe('acct-2')

    webLaunch().relaunch!(ACTIVE_CLAUDE_ACCOUNT)
    expect(webLaunch().startupPlan.launchConfig.claudeAccountId).toBe(ACTIVE_CLAUDE_ACCOUNT)
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
  })
})
