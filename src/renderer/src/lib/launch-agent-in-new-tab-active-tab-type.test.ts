import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSetActiveTabType = vi.fn()

const store = {
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }],
    'global-floating-terminal': [{ id: 'tab-floating' }]
  } as Record<string, { id: string }[]>,
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: vi.fn((worktreeId: string) => ({
    id: worktreeId === 'wt-1' ? 'tab-1' : 'tab-floating'
  })),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
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

// Regression for PR #19965 review: setActiveTabType('terminal') with no worktree arg resolved to
// the store's activeWorktreeId regardless of which worktree this launch actually targeted, so a
// launch into a worktree other than the main window's active one (the floating workspace) would
// silently flip the main window's visible tab type.
describe('launchAgentInNewTab active-tab-type scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes the visible-tab-type flip to the active worktree it launches into', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('does not flip the main window when launching into a different worktree', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'global-floating-terminal' })

    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal', 'global-floating-terminal')
    expect(mockSetActiveTabType).not.toHaveBeenCalledWith('terminal', 'wt-1')
  })
})
