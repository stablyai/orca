import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueueTabStartupCommand = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  allWorktrees: vi.fn(() => [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/worktree' }]),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: () => false,
  isWebTerminalSurfaceTabId: () => false
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: vi.fn().mockResolvedValue(true)
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

// Why: Codex posts no hook while its TUI idles (measured on codex-cli 0.147 —
// SessionStart fires only alongside the first UserPromptSubmit), so the launch
// must carry the spawn-window status itself or the pane stays absent (#6643).
describe('launchAgentInNewTab launch-status seed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.createTab.mockReturnValue({ id: 'tab-1' })
  })

  it('queues a working seed for a Codex argv prompt launch', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', prompt: 'fix the spinner' })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        initialAgentStatus: { agent: 'codex', prompt: 'fix the spinner' }
      })
    )
  })

  it('queues a promptless Codex seed so the pane is present at spawn', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ initialAgentStatus: { agent: 'codex', prompt: '' } })
    )
  })

  it('seeds an unsent Codex draft as presence only, never as a running turn', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      promptDelivery: 'draft'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ initialAgentStatus: { agent: 'codex', prompt: '' } })
    )
  })

  it('keeps seeding Command Code, which shares the hook-silent spawn window', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'command-code', worktreeId: 'wt-1', prompt: 'fix the spinner' })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        initialAgentStatus: { agent: 'command-code', prompt: 'fix the spinner' }
      })
    )
  })

  it('leaves agents that publish a startup row unseeded', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1', prompt: 'fix the spinner' })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.not.objectContaining({ initialAgentStatus: expect.anything() })
    )
  })
})
