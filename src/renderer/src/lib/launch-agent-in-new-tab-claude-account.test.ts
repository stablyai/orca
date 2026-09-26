import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueueTabStartupCommand = vi.fn()

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
  isWebRuntimeSessionActive: () => false
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
})
