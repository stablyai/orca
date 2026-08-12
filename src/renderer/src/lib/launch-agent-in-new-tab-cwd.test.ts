import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueueTabInitialCwd = vi.fn()
const mockLaunchAgentInWebHostTab = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn()
let executionHostId = 'local'

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null as string | null,
    // Why: unrelated to this suite's cwd-delivery assertions; disabled so no
    // rule text leaks into the exact launchCommand strings under test.
    agentSessionRules: { enabled: false, rules: [] as unknown[] }
  },
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  queueTabInitialCwd: mockQueueTabInitialCwd,
  queueTabStartupCommand: vi.fn(),
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

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => executionHostId,
  getRuntimeEnvironmentIdForWorktree: () => 'web-runtime'
}))

vi.mock('@/lib/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
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

describe('launchAgentInNewTab initial cwd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executionHostId = 'local'
    store.repos = []
    store.allWorktrees.mockReturnValue([])
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockLaunchAgentInWebHostTab.mockResolvedValue({
      delivered: true,
      failureNotified: false
    })
  })

  it('queues the original cwd before a local Agent session starts', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    await launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(mockQueueTabInitialCwd).toHaveBeenCalledWith('tab-1', '/repo/worktree/packages/app')
  })

  it('fails closed when an explicit worktree host has no matching repo owner', async () => {
    executionHostId = 'ssh:ssh-a'
    store.allWorktrees.mockReturnValue([
      { id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:ssh-a' } as never
    ])
    store.repos = [{ id: 'repo-1', connectionId: null } as never]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('forwards the original cwd to a paired web runtime', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    await launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        groupId: 'group-1',
        cwd: '/repo/worktree/packages/app'
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('delivers submit-after-ready prompts on the paired host instead of creating a local tab', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = await launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'continue the unfinished task',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        prompt: 'continue the unfinished task',
        promptDelivery: 'submit-after-ready',
        pastePromptAfterReady: 'continue the unfinished task',
        submitPastedPrompt: true
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
  })
})
