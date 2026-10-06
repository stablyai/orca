import type { AgentLaunchProfile } from '../../../shared/agent-launch-profile'
// Execution-host coverage for launchAgentInNewTab, split from launch-agent-in-new-tab.test.ts to
// keep both files within the lines budget.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()

type StoreRepo = {
  id: string
  connectionId: string | null
  executionHostId?: string | null
  path: string
}

type StoreWorktree = {
  id: string
  repoId: string
  projectId: string
  hostId?: string | null
  path: string
  displayName: string
}

type LaunchTestSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  agentLaunchProfiles?: AgentLaunchProfile[]
  experimentalNativeChat?: boolean
  experimentalStructuredNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
}

const initialSettings: LaunchTestSettings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  activeRuntimeEnvironmentId: null
}

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: initialSettings,
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [] as StoreRepo[],
  folderWorkspaces: [] as unknown[],
  projectGroups: [] as unknown[],
  sshConnectionStates: new Map<string, { status: string }>(),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
  worktreesByRepo: {} as Record<string, StoreWorktree[]>,
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1'] ?? []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

function worktreeOn(hostId: string, path: string): StoreWorktree {
  return { id: 'wt-1', repoId: 'repo-1', projectId: 'repo-1', hostId, path, displayName: 'main' }
}

async function launchOnLinux(): Promise<void> {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  launchAgentInNewTab({
    requestId: 'request-1',
    agent: 'claude-agent-teams',
    worktreeId: 'wt-1',
    launchPlatform: 'linux'
  })
}

function queuedCommand(): string {
  return mockQueueTabStartupCommand.mock.calls[0]?.[1]?.command
}

describe('launchAgentInNewTab execution host resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.worktreesByRepo = { 'repo-1': [worktreeOn('local', '/repo/worktree')] }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.folderWorkspaces = []
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.terminalLayoutsByTabId = {}
    store.ptyIdsByTabId = {}
  })

  it.each([
    ['claude', 'wt-1'],
    ['codex', 'wt-1'],
    ['claude', 'folder:local-folder'],
    ['codex', 'folder:local-folder']
  ] as const)(
    'launches external %s profiles in %s only in a fresh terminal with a captured label',
    async (agent, worktreeId) => {
      vi.stubGlobal('navigator', { userAgent: 'Linux' })
      const profile: AgentLaunchProfile = {
        id: 'work',
        name: 'Original',
        agent,
        hostId: 'local',
        executable: `/bin/${agent}`,
        binding: { kind: 'external', home: '/profiles/work' }
      }
      store.folderWorkspaces = [
        {
          id: 'local-folder',
          executionHostId: 'local',
          folderPath: '/folder',
          projectGroupId: 'group'
        }
      ]
      store.settings.agentLaunchProfiles = [profile]
      store.settings.experimentalNativeChat = true
      store.settings.experimentalStructuredNativeChat = true
      store.settings.openAgentTabsInChatByDefault = true
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const result = launchAgentInNewTab({
        requestId: 'profile-terminal',
        agent,
        worktreeId,
        agentProfileId: 'work'
      })
      expect(result?.surface.kind).toBe('local-terminal')
      expect(mockCreateTab).toHaveBeenCalledWith(worktreeId, undefined, undefined, {
        launchAgent: agent,
        quickCommandLabel: 'Original',
        viewMode: 'terminal'
      })
      expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
        'tab-1',
        expect.objectContaining({ agentProfileId: 'work', launchAgent: agent })
      )
      profile.name = 'Renamed'
      store.settings.agentLaunchProfiles = []
      expect(mockCreateTab.mock.calls[0][3].quickCommandLabel).toBe('Original')
      vi.unstubAllGlobals()
    }
  )

  it('refuses an unsupported profile target before publishing a tab or contacting a remote', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    store.settings.agentLaunchProfiles = [
      {
        id: 'work',
        name: 'Work',
        agent: 'claude',
        hostId: 'local',
        executable: '/bin/claude',
        binding: { kind: 'managed', accountId: 'a' }
      }
    ]
    store.repos[0].connectionId = 'ssh-a'
    store.worktreesByRepo = { 'repo-1': [worktreeOn('ssh:ssh-a', '/srv/repo')] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    expect(() =>
      launchAgentInNewTab({
        requestId: 'profile-refused',
        agent: 'claude',
        worktreeId: 'wt-1',
        agentProfileId: 'work'
      })
    ).toThrow(/local/)
    expect(mockCreateTab).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('shapes the launch from the worktree host, not a rival repo row on another SSH host', async () => {
    // `store.repos.find` is host-blind, so a worktree that names its own host could be shaped by
    // an `ssh:openclaw` row it has nothing to do with (#11163).
    store.repos = [
      { id: 'repo-1', connectionId: 'openclaw', path: '/srv/openclaw' },
      { id: 'repo-1', connectionId: null, executionHostId: 'local', path: '/repo' }
    ]
    store.worktreesByRepo = { 'repo-1': [worktreeOn('local', '/repo/worktree')] }

    await launchOnLinux()

    expect(queuedCommand()).toBe("orca-ide claude-teams '--dangerously-skip-permissions'")
  })

  it('keeps a worktree on one SSH host remote while a rival row names another', async () => {
    store.repos = [
      { id: 'repo-1', connectionId: 'openclaw', path: '/srv/openclaw' },
      { id: 'repo-1', connectionId: null, executionHostId: 'ssh:m4air', path: '/srv/m4air' }
    ]
    store.worktreesByRepo = { 'repo-1': [worktreeOn('ssh:m4air', '/srv/m4air/worktree')] }

    await launchOnLinux()

    expect(queuedCommand()).toBe("orca claude-teams '--dangerously-skip-permissions'")
  })

  it('keeps a runtime host reaching a nested SSH target on the relay shim name', async () => {
    store.repos = [
      { id: 'repo-1', connectionId: 'nested', executionHostId: 'runtime:vm-1', path: '/srv/vm' }
    ]
    store.worktreesByRepo = { 'repo-1': [worktreeOn('runtime:vm-1', '/srv/vm/worktree')] }

    await launchOnLinux()

    expect(queuedCommand()).toBe("orca claude-teams '--dangerously-skip-permissions'")
  })

  it('keeps a runtime host with no nested SSH target on the local CLI name', async () => {
    store.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:vm-1', path: '/srv/vm' }
    ]
    store.worktreesByRepo = { 'repo-1': [worktreeOn('runtime:vm-1', '/srv/vm/worktree')] }

    await launchOnLinux()

    expect(queuedCommand()).toBe("orca-ide claude-teams '--dangerously-skip-permissions'")
  })
})
