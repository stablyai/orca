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

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  },
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
  launchAgentInNewTab({ agent: 'claude-agent-teams', worktreeId: 'wt-1', launchPlatform: 'linux' })
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
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.terminalLayoutsByTabId = {}
    store.ptyIdsByTabId = {}
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
