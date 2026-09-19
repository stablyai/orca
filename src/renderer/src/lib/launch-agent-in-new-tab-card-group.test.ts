import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockLaunchAgentInWebHostTab = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn()
const mockResolveAgentLaunchGroupId =
  vi.fn<(worktreeId: string, callerGroupId: string | undefined) => string | undefined>()

// Why annotated consts rather than casts: this repo forbids type assertions, and an empty
// literal inside the double would otherwise infer a uselessly narrow type.
const nullableRuntimeEnvironmentId: string | null = null
const emptyOpenFiles: { id: string; worktreeId: string }[] = []
const emptyBrowserTabs: Record<string, { id: string }[]> = {}
const emptyTabBarOrder: Record<string, string[]> = {}

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: nullableRuntimeEnvironmentId
  },
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: emptyOpenFiles,
  browserTabsByWorktree: emptyBrowserTabs,
  tabBarOrderByWorktree: emptyTabBarOrder,
  resolveAgentLaunchGroupId: mockResolveAgentLaunchGroupId,
  createTab: mockCreateTab,
  queueTabInitialCwd: vi.fn(),
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
  getExecutionHostIdForWorktree: () => 'local',
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

/** Every abandoned launch below would otherwise leave a registered but empty agent card group. */
describe('launchAgentInNewTab agent card group', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockResolveAgentLaunchGroupId.mockReturnValue('card-group-1')
    mockLaunchAgentInWebHostTab.mockResolvedValue({ delivered: true, failureNotified: false })
  })

  it('resolves the card group once the terminal launch is committed', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockResolveAgentLaunchGroupId).toHaveBeenCalledTimes(1)
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', 'card-group-1', undefined, {
      launchAgent: 'codex'
    })
  })

  it('does not resolve a card group when startup validation rejects the launch', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: '--model "unterminated'
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('does not resolve a card group when the caller cancels the terminal surface', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen: () => false
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('does not resolve a card group when the caller cancels a paired host launch', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      beforeSurfaceOpen: () => false
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it('resolves the card group once the paired host launch is committed', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockResolveAgentLaunchGroupId).toHaveBeenCalledTimes(1)
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'card-group-1' })
    )
  })

  it('leaves card group resolution to the provisional tab opener on the structured route', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      agentSessionLaunchPlan: {
        route: 'structured-native-chat',
        agent: 'claude',
        worktreeId: 'wt-1',
        // Why null: a structured launch that never begins must leave no card group behind.
        begin: () => null,
        launch: async () => null
      }
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
  })
})
