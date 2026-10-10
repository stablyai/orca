import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TelemetryModule from '@/lib/telemetry'
import type * as LaunchModuleNamespace from './launch-agent-in-new-tab'
import type * as CapabilitiesModuleNamespace from '@/runtime/local-runtime-capabilities'

type Client = 'darwin' | 'linux' | 'win32'
type Workspace = 'repo' | 'folder'

const USER_AGENT: Record<Client, string> = {
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) Orca',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca'
}
const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`
const HOST_PATH = String.raw`C:\Users\alice\repo`
const WORKTREE_ID = 'repo-1::worktree'
const FOLDER_ID = 'folder:f1'
const BOB = "review Bob's change"

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  queueTabInitialCwd: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  pasteAgentLaunchPromptOnceReady: vi.fn(),
  track: vi.fn()
}))

function makeStore(args: {
  workspace: Workspace
  path: string
  connectionId?: string | null
  terminalWindowsShell?: string
}): Record<string, unknown> {
  const connectionId = args.connectionId ?? null
  const worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]> =
    args.workspace === 'repo'
      ? { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', path: args.path }] }
      : {}
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    settings: {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'https://claude.example.test' } },
      activeRuntimeEnvironmentId: null,
      ...(args.terminalWindowsShell ? { terminalWindowsShell: args.terminalWindowsShell } : {})
    },
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    repos:
      args.workspace === 'repo'
        ? [{ id: 'repo-1', path: args.path, connectionId, displayName: 'repo' }]
        : [],
    worktreesByRepo,
    allWorktrees: () => Object.values(worktreesByRepo).flat(),
    folderWorkspaces: [
      { id: 'f1', projectGroupId: 'pg-1', name: 'folder', folderPath: args.path, connectionId }
    ],
    projectGroups: [{ id: 'pg-1', name: 'group', parentPath: null, parentGroupId: null }],
    sshConnectionStates: new Map([['ssh-1', { status: 'connected' }]]),
    transientClearedAgentStatusConnectionIds: {},
    tabsByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    createTab: mocks.createTab,
    closeTab: vi.fn(),
    queueTabStartupCommand: mocks.queueTabStartupCommand,
    queueTabInitialCwd: mocks.queueTabInitialCwd,
    setActiveTabType: mocks.setActiveTabType,
    setTabBarOrder: mocks.setTabBarOrder,
    setAgentStatus: vi.fn(),
    seedNativeChatLaunchPrompt: vi.fn(),
    seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
    markNativeChatLaunchPromptFailed: vi.fn()
  }
}

let store = makeStore({ workspace: 'repo', path: '/repo/worktree' })

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn((_stored, termIds: string[]) => termIds)
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: mocks.pasteAgentLaunchPromptOnceReady
}))
// Why: decline the host route the way launch-agent-in-new-tab.test.ts does; this file pins the window branch.
vi.mock('@/lib/launch-agent-new-tab-host-route', () => ({
  newTabPromptLaunchesThroughHost: () => false,
  launchNewTabPromptThroughHost: vi.fn()
}))
// Why real tuiAgentToAgentKind: the agent_kind the window stamps is part of the baseline.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryModule>()),
  track: mocks.track
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

type LaunchModule = typeof LaunchModuleNamespace
type CapabilitiesModule = typeof CapabilitiesModuleNamespace
const launchByClient = new Map<Client, LaunchModule>()

async function loadLaunchForClient(client: Client): Promise<LaunchModule> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = launchByClient.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const launch = await import('./launch-agent-in-new-tab')
  const capabilities: CapabilitiesModule = await import('@/runtime/local-runtime-capabilities')
  // The local runtime has answered (without structured support), so no launch waits on it.
  capabilities.setLocalRuntimeCapabilitiesForTests([])
  launchByClient.set(client, launch)
  return launch
}

const POSIX_CLAUDE = "claude '--dangerously-skip-permissions'"
const CLAUDE_ENV = { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
const CODEX_ARGS = '--dangerously-bypass-approvals-and-sandbox'

type Case = {
  name: string
  client: Client
  workspace: Workspace
  path: string
  connectionId?: string
  terminalWindowsShell?: string
  agent: 'claude' | 'codex'
  promptDelivery: 'auto-submit' | 'draft'
  expected: Record<string, unknown>
}

function claudeDraft(command: string, agentCommand: string): Record<string, unknown> {
  return {
    command,
    env: CLAUDE_ENV,
    launchConfig: {
      agentCommand,
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: CLAUDE_ENV
    },
    launchAgent: 'claude',
    telemetry: { agent_kind: 'claude-code', launch_source: 'quick_command', request_kind: 'new' }
  }
}

function codexAutoSubmit(command: string, agentCommand: string): Record<string, unknown> {
  return {
    command,
    env: {},
    launchConfig: { agentCommand, agentArgs: CODEX_ARGS, agentEnv: {} },
    launchAgent: 'codex',
    startupCommandDelivery: 'shell-ready',
    telemetry: { agent_kind: 'codex', launch_source: 'quick_command', request_kind: 'new' }
  }
}

const CASES: Case[] = [
  {
    name: 'darwin local repo, codex auto-submit',
    client: 'darwin',
    workspace: 'repo',
    path: '/repo/worktree',
    agent: 'codex',
    promptDelivery: 'auto-submit',
    expected: codexAutoSubmit(
      `codex '${CODEX_ARGS}' 'review Bob'"'"'s change'`,
      `codex '${CODEX_ARGS}'`
    )
  },
  {
    name: 'linux local repo, claude draft rides --prefill',
    client: 'linux',
    workspace: 'repo',
    path: '/repo/worktree',
    agent: 'claude',
    promptDelivery: 'draft',
    expected: claudeDraft(`${POSIX_CLAUDE} --prefill 'review Bob'"'"'s change'`, POSIX_CLAUDE)
  },
  {
    name: 'win32 local C:\\ repo, PowerShell, claude draft',
    client: 'win32',
    workspace: 'repo',
    path: HOST_PATH,
    terminalWindowsShell: 'powershell.exe',
    agent: 'claude',
    promptDelivery: 'draft',
    expected: claudeDraft(`${POSIX_CLAUDE} --prefill 'review Bob''s change'`, POSIX_CLAUDE)
  },
  {
    name: 'win32 local C:\\ repo, cmd.exe, codex auto-submit',
    client: 'win32',
    workspace: 'repo',
    path: HOST_PATH,
    terminalWindowsShell: 'cmd.exe',
    agent: 'codex',
    promptDelivery: 'auto-submit',
    expected: codexAutoSubmit(
      `codex "${CODEX_ARGS}" "review Bob's change"`,
      `codex "${CODEX_ARGS}"`
    )
  },
  {
    // The UNC path resolves the project runtime to WSL, so the window quotes for posix.
    name: 'win32 local \\\\wsl$ repo, cmd.exe setting, claude draft quotes posix',
    client: 'win32',
    workspace: 'repo',
    path: WSL_PATH,
    terminalWindowsShell: 'cmd.exe',
    agent: 'claude',
    promptDelivery: 'draft',
    expected: claudeDraft(`${POSIX_CLAUDE} --prefill 'review Bob'"'"'s change'`, POSIX_CLAUDE)
  },
  {
    name: 'win32 client, SSH linux repo, claude draft',
    client: 'win32',
    workspace: 'repo',
    path: '/home/alice/repo',
    connectionId: 'ssh-1',
    terminalWindowsShell: 'cmd.exe',
    agent: 'claude',
    promptDelivery: 'draft',
    expected: claudeDraft(`${POSIX_CLAUDE} --prefill 'review Bob'"'"'s change'`, POSIX_CLAUDE)
  },
  {
    // A remote Windows host gets PowerShell quoting; the local cmd.exe setting is ignored.
    name: 'win32 client, SSH Windows-path repo, codex auto-submit',
    client: 'win32',
    workspace: 'repo',
    path: String.raw`C:\remote\repo`,
    connectionId: 'ssh-1',
    terminalWindowsShell: 'cmd.exe',
    agent: 'codex',
    promptDelivery: 'auto-submit',
    expected: codexAutoSubmit(
      `codex '${CODEX_ARGS}' 'review Bob''s change'`,
      `codex '${CODEX_ARGS}'`
    )
  },
  {
    // main today: a folder has no allWorktrees row, so a \\wsl$ folder is quoted for PowerShell
    // while createTab gives the tab wsl.exe (known mismatch, pinned as-is).
    name: 'win32 local folder at \\\\wsl$, PowerShell, claude draft',
    client: 'win32',
    workspace: 'folder',
    path: WSL_PATH,
    terminalWindowsShell: 'powershell.exe',
    agent: 'claude',
    promptDelivery: 'draft',
    expected: claudeDraft(`${POSIX_CLAUDE} --prefill 'review Bob''s change'`, POSIX_CLAUDE)
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (row 2, rule WINDOW_PLANNER): the exact queued startup a typed-prompt new tab hands the window pane.
describe('row 2: launchAgentInNewTab window branch queued startup on main', () => {
  // Why: the first import transforms the whole store graph; keep that out of the first case.
  beforeAll(async () => {
    for (const client of ['darwin', 'linux', 'win32'] as const) {
      await loadLaunchForClient(client)
    }
  }, 120_000)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createTab.mockReturnValue({ id: 'tab-new' })
    mocks.pasteAgentLaunchPromptOnceReady.mockResolvedValue({
      delivered: true,
      failureNotified: false
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(CASES)('$name', async (c) => {
    store = makeStore({
      workspace: c.workspace,
      path: c.path,
      connectionId: c.connectionId ?? null,
      terminalWindowsShell: c.terminalWindowsShell
    })
    const { launchAgentInNewTab } = await loadLaunchForClient(c.client)
    const worktreeId = c.workspace === 'repo' ? WORKTREE_ID : FOLDER_ID

    const result = launchAgentInNewTab({
      requestId: `request-${c.name}`,
      agent: c.agent,
      worktreeId,
      groupId: 'group-1',
      prompt: `  ${BOB}  `,
      promptDelivery: c.promptDelivery,
      launchSource: 'quick_command'
    })

    expect(result?.surface).toStrictEqual({ kind: 'local-terminal', tabId: 'tab-new' })
    expect(result?.pasteDraftAfterLaunch).toBe(false)
    expect(mocks.createTab.mock.calls).toStrictEqual([
      [worktreeId, 'group-1', undefined, { launchAgent: c.agent, quickCommandLabel: undefined }]
    ])
    expect(mocks.queueTabStartupCommand).toHaveBeenCalledTimes(1)
    expect(mocks.queueTabStartupCommand.mock.calls[0][0]).toBe('tab-new')
    expect(mocks.queueTabStartupCommand.mock.calls[0][1]).toStrictEqual(c.expected)
    expect(mocks.queueTabInitialCwd).not.toHaveBeenCalled()
    expect(mocks.pasteAgentLaunchPromptOnceReady).not.toHaveBeenCalled()
    // An argv draft is mirrored into the chat composer; an auto-submit is not.
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledTimes(
      c.promptDelivery === 'draft' ? 1 : 0
    )
    expect(mocks.setActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', worktreeId)
    expect(mocks.setTabBarOrder).toHaveBeenCalledExactlyOnceWith(worktreeId, ['tab-new'])
  })

  it('launches a stdin-after-start agent empty and pastes its auto-submit prompt unsubmitted', async () => {
    store = makeStore({ workspace: 'repo', path: '/repo/worktree' })
    const { launchAgentInNewTab } = await loadLaunchForClient('darwin')

    const result = launchAgentInNewTab({
      requestId: 'request-autohand',
      agent: 'autohand',
      worktreeId: WORKTREE_ID,
      prompt: BOB,
      promptDelivery: 'auto-submit'
    })

    expect(result?.pasteDraftAfterLaunch).toBe(true)
    expect(result?.promptDeliveryResult).toBeUndefined()
    expect(mocks.queueTabStartupCommand.mock.calls[0][1]).toStrictEqual({
      command: "autohand '--unrestricted'",
      env: {},
      launchConfig: {
        agentCommand: "autohand '--unrestricted'",
        agentArgs: '--unrestricted',
        agentEnv: {}
      },
      launchAgent: 'autohand',
      telemetry: {
        agent_kind: 'autohand',
        launch_source: 'tab_bar_quick_launch',
        request_kind: 'new'
      }
    })
    expect(mocks.pasteAgentLaunchPromptOnceReady).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-new',
      agent: 'autohand',
      content: BOB,
      submit: false,
      prompt: BOB
    })
  })

  it('queues the caller initialCwd for the pane before the startup command', async () => {
    store = makeStore({ workspace: 'repo', path: '/repo/worktree' })
    const { launchAgentInNewTab } = await loadLaunchForClient('darwin')

    launchAgentInNewTab({
      requestId: 'request-cwd',
      agent: 'codex',
      worktreeId: WORKTREE_ID,
      prompt: 'fix it',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(mocks.queueTabInitialCwd).toHaveBeenCalledExactlyOnceWith(
      'tab-new',
      '/repo/worktree/packages/app'
    )
    expect(mocks.queueTabInitialCwd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queueTabStartupCommand.mock.invocationCallOrder[0]
    )
    expect(mocks.queueTabStartupCommand.mock.calls[0][1]).toStrictEqual({
      ...codexAutoSubmit(`codex '${CODEX_ARGS}' 'fix it'`, `codex '${CODEX_ARGS}'`),
      telemetry: { agent_kind: 'codex', launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
    })
  })
})
