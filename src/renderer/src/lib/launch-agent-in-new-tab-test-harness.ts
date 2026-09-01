// Shared fixtures for the launchAgentInNewTab suites. The vi.mock calls stay in
// each test file (they are hoisted per module), but their factories read the
// mock functions from here so both files drive one set of doubles.
import { vi, type Mock } from 'vitest'

export const mockCreateTab: Mock = vi.fn()
export const mockQueueTabStartupCommand: Mock = vi.fn()
export const mockSetActiveTabType: Mock = vi.fn()
export const mockSetTabBarOrder: Mock = vi.fn()
export const mockSetAgentStatus: Mock = vi.fn()
export const mockPasteDraftWhenAgentReady: Mock = vi.fn()
export const mockSeedNativeChatLaunchPrompt: Mock = vi.fn()
export const mockSeedNativeChatLaunchDraft: Mock = vi.fn()
export const mockMarkNativeChatLaunchPromptFailed: Mock = vi.fn()
export const mockTrack: Mock = vi.fn()
export const mockToastMessage: Mock = vi.fn()
export const mockToastError: Mock = vi.fn()
export const mockCreateWebRuntimeSessionTerminal: Mock = vi.fn()
export const mockCreateWebRuntimeAgentSessionTerminal: Mock = vi.fn()
export const mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft: Mock = vi.fn()
export const mockIsWebRuntimeSessionActive: Mock = vi.fn(() => false)

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'

export const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    customTuiAgents?: {
      id: string
      baseAgent: string
      label: string
      args: string
      env: Record<string, string>
      syncEnv: boolean
    }[]
    terminalWindowsShell?: string
    experimentalNativeChat?: boolean
    openAgentTabsInChatByDefault?: boolean
    nativeChatSessionOptions?: Record<
      string,
      { model?: string; valuesByModel?: Record<string, Record<string, string | boolean>> }
    >
  },
  projects: [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' as const }
    }
  ] as {
    id: string
    localWindowsRuntimePreference:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string | null }
  }[],
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
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
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']) as Mock,
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn() as Mock,
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  seedNativeChatLaunchDraft: mockSeedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

/** Restores every fixture the suites mutate; call from each beforeEach. */
export function resetLaunchAgentInNewTabHarness(): void {
  vi.clearAllMocks()
  mockIsWebRuntimeSessionActive.mockReturnValue(false)
  mockCreateWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  mockCreateWebRuntimeAgentSessionTerminal.mockResolvedValue({
    outcome: { status: 'created' },
    promptDelivered: true
  })
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({ status: 'created' })
  store.activeRepoId = 'repo-1'
  store.activeWorktreeId = 'wt-1'
  store.settings = {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null
  }
  store.projects = [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' }
    }
  ]
  store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
  store.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
  store.transientClearedAgentStatusConnectionIds = {}
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
  store.ptyIdsByTabId = {}
  mockCreateTab.mockReturnValue({ id: 'tab-1' })
  mockPasteDraftWhenAgentReady.mockResolvedValue(true)
}
