import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  closeTab: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  setActiveTabType: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn()
}))

// Why: CLIENT_PLATFORM reads the user agent at import; pin posix quoting for the startup plan.
vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca' })

type StoreSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
}
const initialSettings: StoreSettings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  activeRuntimeEnvironmentId: 'web-runtime'
}
const initialTabs: { id: string; launchAgent?: string }[] = [{ id: 'tab-1' }]
const openFiles: { id: string; worktreeId: string }[] = []
const browserTabsByWorktree: Record<string, { id: string }[]> = {}
const tabBarOrderByWorktree: Record<string, string[]> = {}

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: initialSettings,
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
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
  tabsByWorktree: { 'wt-1': initialTabs },
  openFiles,
  browserTabsByWorktree,
  tabBarOrderByWorktree,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: mocks.queueTabStartupCommand,
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
// Why: decline the host route the way launch-agent-in-new-tab.test.ts does; the paired branch runs first anyway.
vi.mock('@/lib/launch-agent-new-tab-host-route', () => ({
  newTabPromptLaunchesThroughHost: () => false,
  launchNewTabPromptThroughHost: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminal: mocks.createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft:
    mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  isWebRuntimeSessionActive: vi.fn(() => true),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

const CLAUDE_CONFIG = {
  agentCommand: "claude '--dangerously-skip-permissions'",
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}
const BASE_LAUNCH = {
  worktreeId: 'wt-1',
  environmentId: 'web-runtime',
  targetGroupId: 'group-1',
  activate: true,
  viewMode: 'terminal',
  agentSessionKind: 'fresh'
}

// Pins main's current launch behaviour as the convergence parity baseline (row 7): the exact launch object a typed-prompt new tab hands the paired-host creation API.
describe('row 7: launchAgentInNewTab paired web host launch on main', () => {
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({
      status: 'created'
    })
  })

  it('sends a Claude argv draft through the launch-draft creator', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-draft',
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: "  review Bob's change  ",
      promptDelivery: 'draft'
    })

    expect(result?.surface).toStrictEqual({ kind: 'host-published' })
    expect(result?.pasteDraftAfterLaunch).toBe(false)
    expect(result?.promptDeliveryResult).toBeUndefined()
    expect(mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft.mock.calls).toStrictEqual([
      [
        {
          ...BASE_LAUNCH,
          launchAgent: 'claude',
          command: `claude '--dangerously-skip-permissions' --prefill 'review Bob'"'"'s change'`,
          env: {},
          launchConfig: CLAUDE_CONFIG,
          prompt: "review Bob's change",
          promptDelivery: 'draft',
          agent: 'claude',
          launchDraft: "review Bob's change"
        }
      ]
    ])
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeAgentSessionTerminal).not.toHaveBeenCalled()
    // The paired host owns the tab: nothing is created, queued or seeded locally.
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(mocks.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it.each([
    {
      // An explicit caller agentArgs replaces the default args and rides on the launch as-is.
      name: 'caller agentArgs',
      extra: { agentArgs: '--model gpt-5' },
      expected: {
        command: "codex '--model' 'gpt-5' 'fix it'",
        launchConfig: {
          agentCommand: "codex '--model' 'gpt-5'",
          agentArgs: '--model gpt-5',
          agentEnv: {}
        },
        agentArgs: '--model gpt-5'
      }
    },
    {
      name: 'initialCwd',
      extra: { initialCwd: '/repo/worktree/packages/app' },
      expected: {
        cwd: '/repo/worktree/packages/app',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix it'",
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        }
      }
    }
  ])('sends a Codex auto-submit with $name', async ({ extra, expected }) => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-codex',
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'fix it',
      ...extra
    })

    expect(mocks.createWebRuntimeSessionTerminal.mock.calls).toStrictEqual([
      [
        {
          ...BASE_LAUNCH,
          launchAgent: 'codex',
          env: {},
          startupCommandDelivery: 'shell-ready',
          prompt: 'fix it',
          promptDelivery: 'auto-submit',
          ...expected
        }
      ]
    ])
    expect(mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft).not.toHaveBeenCalled()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})
