import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useAppStore } from '@/store'
import type * as LaunchModuleNamespace from './launch-agent-background-session'
import type * as LaunchHostModuleNamespace from './agent-background-session-launch-host'
import {
  AGENT_BACKGROUND_SESSION_UUID_RE as UUID_RE,
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness
} from '@/lib/agent-background-session-test-state'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockDispatchEvent = vi.fn()
// Sink for the harness platform-mock reset: this file runs the real launch-platform rule.
const unusedLaunchPlatformMock = vi.fn()
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: vi.fn(() => () => {})
  }
}))

// Why the real agent-kind map: telemetry.agent_kind is a pinned fact here, not the harness's identity stub.
vi.mock('@/lib/telemetry', async () => {
  const agentKind = await import('../../../shared/agent-kind')
  return { track: vi.fn(), tuiAgentToAgentKind: agentKind.tuiAgentToAgentKind }
})

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

type Client = 'win32' | 'darwin' | 'linux'
type LaunchModules = {
  launch: typeof LaunchModuleNamespace
  host: typeof LaunchHostModuleNamespace
}
type LaunchStore = ReturnType<typeof useAppStore.getState>

const USER_AGENT: Record<Client, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) Orca'
}
const modulesByClient = new Map<Client, LaunchModules>()

async function loadForClient(client: Client): Promise<LaunchModules> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = modulesByClient.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const modules = {
    launch: await import('./launch-agent-background-session'),
    host: await import('./agent-background-session-launch-host')
  }
  modulesByClient.set(client, modules)
  return modules
}

const SSH = 'ssh-1'
// Why an apostrophe: it is the byte that tells POSIX, PowerShell and cmd quoting apart.
const PROMPT = "don't stop"
const POSIX_PROMPT = `'don'"'"'t stop'`
const POWERSHELL_PROMPT = `'don''t stop'`
const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\me\project`
const FOLDER_ID = 'folder:fw-1'

function setRepoWorkspace(args: {
  path: string
  worktreePath: string
  connectionId?: string | null
  projectRuntime?: 'wsl'
}): void {
  state.repos = [{ id: 'repo-1', connectionId: args.connectionId ?? null, path: args.path }]
  state.worktreesByRepo['repo-1'] = [
    {
      id: 'wt-1',
      repoId: 'repo-1',
      projectId: 'repo-1',
      path: args.worktreePath,
      displayName: 'feature'
    }
  ]
  if (args.projectRuntime === 'wsl') {
    state.projects = [
      { id: 'repo-1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
    ]
  }
}

function setFolderWorkspace(args: { folderPath: string; connectionId?: string | null }): void {
  const connectionId = args.connectionId ?? null
  state.worktreesByRepo['repo-1'] = []
  state.folderWorkspaces = [
    { id: 'fw-1', projectGroupId: 'grp-1', folderPath: args.folderPath, connectionId }
  ]
  state.projectGroups = [{ id: 'grp-1', parentGroupId: null, connectionId }]
  state.getKnownWorktreeById = (worktreeId: string) =>
    worktreeId === FOLDER_ID ? { id: FOLDER_ID, path: args.folderPath } : undefined
}

const CLAUDE_POSIX_CONFIG = {
  agentCommand: "claude '--dangerously-skip-permissions'",
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}
const SSH_DELIVERY = { commandDelivery: 'provider', startupCommandDelivery: 'shell-ready' }

type SpawnCase = {
  name: string
  client: Client
  agent: 'claude' | 'codex' | 'aider'
  setup: () => void
  worktreeId: string
  cwd: string
  connectionId: string | null
  /** Keys main sends beyond the always-present ones; absent keys must stay absent. */
  extra: Record<string, unknown>
  command: string
  launchConfig: Record<string, unknown>
  startupEnv: Record<string, string>
  agentKind: string
  title?: string
}

const SPAWN_CASES: SpawnCase[] = [
  {
    name: 'local POSIX repo (macOS client)',
    client: 'darwin',
    agent: 'claude',
    setup: () => setRepoWorkspace({ path: '/repo', worktreePath: '/repo/worktree' }),
    worktreeId: 'wt-1',
    cwd: '/repo/worktree',
    connectionId: null,
    extra: {},
    command: `claude '--dangerously-skip-permissions' ${POSIX_PROMPT}`,
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    name: 'local win32 repo, PowerShell default',
    client: 'win32',
    agent: 'claude',
    setup: () =>
      setRepoWorkspace({ path: String.raw`C:\repo`, worktreePath: String.raw`C:\repo\feature` }),
    worktreeId: 'wt-1',
    cwd: String.raw`C:\repo\feature`,
    connectionId: null,
    extra: {},
    command: `claude '--dangerously-skip-permissions' ${POWERSHELL_PROMPT}`,
    // launchConfig matches POSIX: a single-quoted flag is literal in both shells.
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    name: 'local win32 repo, cmd.exe shell setting',
    client: 'win32',
    agent: 'claude',
    setup: () => {
      setRepoWorkspace({ path: String.raw`C:\repo`, worktreePath: String.raw`C:\repo\feature` })
      Object.assign(state.settings, { terminalWindowsShell: 'cmd.exe' })
    },
    worktreeId: 'wt-1',
    cwd: String.raw`C:\repo\feature`,
    connectionId: null,
    extra: {},
    command: `claude "--dangerously-skip-permissions" "don't stop"`,
    launchConfig: {
      agentCommand: 'claude "--dangerously-skip-permissions"',
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    },
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    // main today: POSIX-quoted, yet neither shellOverride nor projectRuntime is sent, so main picks the settings shell.
    name: 'local win32 C:\\ repo whose project runtime is WSL',
    client: 'win32',
    agent: 'claude',
    setup: () =>
      setRepoWorkspace({
        path: String.raw`C:\repo`,
        worktreePath: String.raw`C:\repo\feature`,
        projectRuntime: 'wsl'
      }),
    worktreeId: 'wt-1',
    cwd: String.raw`C:\repo\feature`,
    connectionId: null,
    extra: {},
    command: `claude '--dangerously-skip-permissions' ${POSIX_PROMPT}`,
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    // AUTOMATION_WSL_EXE: the only case that sends a shellOverride.
    name: 'local \\\\wsl$ folder (win32 client)',
    client: 'win32',
    agent: 'claude',
    setup: () => setFolderWorkspace({ folderPath: WSL_PATH }),
    worktreeId: FOLDER_ID,
    cwd: WSL_PATH,
    connectionId: null,
    extra: { shellOverride: 'wsl.exe' },
    command: `claude '--dangerously-skip-permissions' ${POSIX_PROMPT}`,
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    // main today: wsl.exe runs a PowerShell-quoted line, because the inherit-global project resolves Windows quoting.
    name: 'local \\\\wsl$ repo, inherit-global project (win32 client)',
    client: 'win32',
    agent: 'claude',
    setup: () => setRepoWorkspace({ path: WSL_PATH, worktreePath: WSL_PATH }),
    worktreeId: 'wt-1',
    cwd: WSL_PATH,
    connectionId: null,
    extra: { shellOverride: 'wsl.exe' },
    command: `claude '--dangerously-skip-permissions' ${POWERSHELL_PROMPT}`,
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    name: 'local C:\\ folder (win32 client)',
    client: 'win32',
    agent: 'claude',
    setup: () => setFolderWorkspace({ folderPath: String.raw`C:\work\folder` }),
    worktreeId: FOLDER_ID,
    cwd: String.raw`C:\work\folder`,
    connectionId: null,
    extra: {},
    command: `claude '--dangerously-skip-permissions' ${POWERSHELL_PROMPT}`,
    // launchConfig matches POSIX: a single-quoted flag is literal in both shells.
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    // Quoting follows the SSH repo path, not the Windows client.
    name: 'SSH linux repo (win32 client)',
    client: 'win32',
    agent: 'claude',
    setup: () =>
      setRepoWorkspace({ path: '/srv/repo', worktreePath: '/srv/repo/feature', connectionId: SSH }),
    worktreeId: 'wt-1',
    cwd: '/srv/repo/feature',
    connectionId: SSH,
    extra: SSH_DELIVERY,
    command: `claude '--dangerously-skip-permissions' ${POSIX_PROMPT}`,
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    name: 'SSH Windows-path repo (macOS client)',
    client: 'darwin',
    agent: 'claude',
    setup: () =>
      setRepoWorkspace({
        path: String.raw`C:\srv\repo`,
        worktreePath: String.raw`C:\srv\repo\feature`,
        connectionId: SSH
      }),
    worktreeId: 'wt-1',
    cwd: String.raw`C:\srv\repo\feature`,
    connectionId: SSH,
    extra: SSH_DELIVERY,
    command: `claude '--dangerously-skip-permissions' ${POWERSHELL_PROMPT}`,
    // launchConfig matches POSIX: a single-quoted flag is literal in both shells.
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    name: 'SSH folder with a Windows path (macOS client)',
    client: 'darwin',
    agent: 'claude',
    setup: () => setFolderWorkspace({ folderPath: String.raw`D:\work\folder`, connectionId: SSH }),
    worktreeId: FOLDER_ID,
    cwd: String.raw`D:\work\folder`,
    connectionId: SSH,
    extra: SSH_DELIVERY,
    command: `claude '--dangerously-skip-permissions' ${POWERSHELL_PROMPT}`,
    // launchConfig matches POSIX: a single-quoted flag is literal in both shells.
    launchConfig: CLAUDE_POSIX_CONFIG,
    startupEnv: {},
    agentKind: 'claude-code',
    title: 'Nightly audit'
  },
  {
    // Local codex with a prompt asks main to wait for the shell; no title means no placement row.
    name: 'local POSIX repo, codex prompt, no title',
    client: 'linux',
    agent: 'codex',
    setup: () => setRepoWorkspace({ path: '/repo', worktreePath: '/repo/worktree' }),
    worktreeId: 'wt-1',
    cwd: '/repo/worktree',
    connectionId: null,
    extra: { startupCommandDelivery: 'shell-ready' },
    command: `codex '--dangerously-bypass-approvals-and-sandbox' ${POSIX_PROMPT}`,
    launchConfig: {
      agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: {}
    },
    startupEnv: {},
    agentKind: 'codex'
  },
  {
    // stdin-after-start: the prompt is pasted after launch, never on argv.
    name: 'local POSIX repo, aider (stdin-after-start)',
    client: 'linux',
    agent: 'aider',
    setup: () => setRepoWorkspace({ path: '/repo', worktreePath: '/repo/worktree' }),
    worktreeId: 'wt-1',
    cwd: '/repo/worktree',
    connectionId: null,
    extra: {},
    command: "aider '--yes-always'",
    launchConfig: { agentCommand: "aider '--yes-always'", agentArgs: '--yes-always', agentEnv: {} },
    startupEnv: {},
    agentKind: 'aider',
    title: 'Nightly audit'
  }
]

function resetHarness(): void {
  resetAgentBackgroundSessionTestHarness({
    state,
    createTab: mockCreateTab,
    closeTab: mockCloseTab,
    getLaunchPlatform: unusedLaunchPlatformMock,
    runtimeCall: mockRuntimeEnvironmentCall,
    runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
    runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
    subscribeToData: mockSubscribeToPtyData,
    subscribeToExit: mockSubscribeToPtyExit,
    setTabLayout: mockSetTabLayout,
    updateTabPtyId: mockUpdateTabPtyId,
    dispatchEvent: mockDispatchEvent,
    kill: mockKill,
    spawn: mockSpawn,
    write: mockWrite
  })
}

function spawnPayload(): Record<string, unknown> & {
  tabId: string
  leafId: string
  launchToken: string
} {
  expect(mockSpawn).toHaveBeenCalledOnce()
  const payload = mockSpawn.mock.calls[0]?.[0]
  expect(payload.tabId).toMatch(UUID_RE)
  expect(payload.leafId).toMatch(UUID_RE)
  expect(payload.launchToken).toMatch(UUID_RE)
  return payload
}

// Pins main's current launch behaviour as the convergence parity baseline (row 5, rule AUTOMATION_WSL_EXE): the full window.api.pty.spawn payload a desktop automation sends.
describe('row 5: launchAgentBackgroundSession spawn payload on main', () => {
  beforeAll(async () => {
    for (const client of ['win32', 'darwin', 'linux'] as const) {
      await loadForClient(client)
    }
  }, 120_000)

  beforeEach(resetHarness)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(SPAWN_CASES)('$name', async (testCase) => {
    const { launch } = await loadForClient(testCase.client)
    testCase.setup()

    await launch.launchAgentBackgroundSession({
      agent: testCase.agent,
      worktreeId: testCase.worktreeId,
      prompt: PROMPT,
      // Automation dispatch always passes 'unknown'.
      launchSource: 'unknown',
      ...(testCase.title ? { title: testCase.title } : {})
    })

    const payload = spawnPayload()
    const { tabId, leafId, launchToken } = payload
    expect(payload).toStrictEqual({
      cols: 120,
      rows: 40,
      cwd: testCase.cwd,
      command: testCase.command,
      ...testCase.extra,
      env: {
        ...testCase.startupEnv,
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: testCase.worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: launchToken
      },
      launchConfig: testCase.launchConfig,
      launchToken,
      launchAgent: testCase.agent,
      connectionId: testCase.connectionId,
      worktreeId: testCase.worktreeId,
      tabId,
      leafId,
      placement: {
        kind: 'new-tab',
        ...(testCase.title ? { row: { customTitle: testCase.title } } : {})
      },
      telemetry: { agent_kind: testCase.agentKind, launch_source: 'unknown', request_kind: 'new' }
    })
  })

  it('pastes the aider prompt after launch instead of putting it on argv', async () => {
    const { launch } = await loadForClient('linux')
    await launch.launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'run the audit'
    })
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'run the audit', agent: 'aider', submit: true })
    )
  })

  it('defaults launch_source to unknown when the caller passes none', async () => {
    const { launch } = await loadForClient('linux')
    await launch.launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1', prompt: 'x' })
    expect(spawnPayload().telemetry).toStrictEqual({
      agent_kind: 'claude-code',
      launch_source: 'unknown',
      request_kind: 'new'
    })
  })

  // main today: no disabled-agent check on this route, so a disabled agent still spawns.
  it.each(['local', 'ssh'] as const)('spawns a disabled agent (%s)', async (host) => {
    const { launch } = await loadForClient('linux')
    if (host === 'ssh') {
      setRepoWorkspace({ path: '/srv/repo', worktreePath: '/srv/repo/feature', connectionId: SSH })
    }
    Object.assign(state.settings, { disabledTuiAgents: ['claude'] })

    await expect(
      launch.launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1', prompt: 'x' })
    ).resolves.toMatchObject({ ptyId: 'pty-1' })
    expect(spawnPayload()).toMatchObject({
      launchAgent: 'claude',
      connectionId: host === 'ssh' ? SSH : null
    })
  })
})

type HostCase = {
  name: string
  client: Exclude<Client, 'linux'>
  workspace: 'repo' | 'folder'
  path: string
  connectionId: string | null
  projectRuntime?: 'wsl' | 'none'
  expected: Record<string, unknown>
}

function makeHostStore(testCase: HostCase): LaunchStore {
  const isRepo = testCase.workspace === 'repo'
  const repo = { id: 'repo-1', connectionId: testCase.connectionId, path: testCase.path }
  const store = {
    activeRepoId: null,
    activeWorktreeId: null,
    settings: {},
    projects:
      testCase.projectRuntime === 'none'
        ? []
        : [
            {
              id: 'repo-1',
              localWindowsRuntimePreference:
                testCase.projectRuntime === 'wsl'
                  ? { kind: 'wsl', distro: 'Ubuntu' }
                  : { kind: 'inherit-global' }
            }
          ],
    repos: isRepo ? [repo] : [],
    worktreesByRepo: isRepo
      ? { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', projectId: 'repo-1', path: testCase.path }] }
      : {},
    folderWorkspaces: isRepo
      ? []
      : [
          {
            id: 'fw-1',
            projectGroupId: 'grp-1',
            folderPath: testCase.path,
            connectionId: testCase.connectionId
          }
        ],
    projectGroups: isRepo
      ? []
      : [{ id: 'grp-1', parentGroupId: null, connectionId: testCase.connectionId }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch host reads only repos, projects, settings, worktreesByRepo, folderWorkspaces, projectGroups and the active ids, all present here.
  return store as unknown as LaunchStore
}

const LOCAL_REPO = (platform: string): Record<string, unknown> => ({
  connectionId: null,
  platform,
  isRemote: false,
  expectedConnectionId: null
})
const LOCAL_FOLDER = (platform: string): Record<string, unknown> => ({
  connectionId: null,
  platform,
  isRemote: false,
  expectedConnectionId: null
})
const SSH_HOST = (platform: string): Record<string, unknown> => ({
  connectionId: SSH,
  platform,
  isRemote: true,
  expectedConnectionId: SSH
})

// Dropped: local C:\ or \\wsl$ paths on a macOS client and local POSIX paths on a Windows client
// (no such local workspace exists); SSH \\wsl$ paths (a WSL UNC path is a Windows-client-local form).
const HOST_CASES: HostCase[] = [
  {
    name: 'win32 client, local C:\\ repo',
    client: 'win32',
    workspace: 'repo',
    path: String.raw`C:\repo`,
    connectionId: null,
    expected: LOCAL_REPO('win32')
  },
  {
    name: 'win32 client, local C:\\ repo, WSL project runtime',
    client: 'win32',
    workspace: 'repo',
    path: String.raw`C:\repo`,
    connectionId: null,
    projectRuntime: 'wsl',
    expected: LOCAL_REPO('linux')
  },
  // main today: an explicit inherit-global project keeps a \\wsl$ repo on Windows quoting.
  {
    name: 'win32 client, local \\\\wsl$ repo, inherit-global project',
    client: 'win32',
    workspace: 'repo',
    path: WSL_PATH,
    connectionId: null,
    expected: LOCAL_REPO('win32')
  },
  // Only a repo with no project row infers WSL from the UNC path.
  {
    name: 'win32 client, local \\\\wsl$ repo, no project row',
    client: 'win32',
    workspace: 'repo',
    path: WSL_PATH,
    connectionId: null,
    projectRuntime: 'none',
    expected: LOCAL_REPO('linux')
  },
  {
    name: 'win32 client, local C:\\ folder',
    client: 'win32',
    workspace: 'folder',
    path: String.raw`C:\work\folder`,
    connectionId: null,
    expected: LOCAL_FOLDER('win32')
  },
  {
    name: 'win32 client, local \\\\wsl$ folder',
    client: 'win32',
    workspace: 'folder',
    path: WSL_PATH,
    connectionId: null,
    expected: LOCAL_FOLDER('linux')
  },
  {
    name: 'win32 client, SSH POSIX repo',
    client: 'win32',
    workspace: 'repo',
    path: '/srv/repo',
    connectionId: SSH,
    expected: SSH_HOST('linux')
  },
  {
    name: 'win32 client, SSH C:\\ repo',
    client: 'win32',
    workspace: 'repo',
    path: String.raw`C:\srv\repo`,
    connectionId: SSH,
    expected: SSH_HOST('win32')
  },
  {
    name: 'win32 client, SSH POSIX folder',
    client: 'win32',
    workspace: 'folder',
    path: '/srv/folder',
    connectionId: SSH,
    expected: SSH_HOST('linux')
  },
  {
    name: 'win32 client, SSH C:\\ folder',
    client: 'win32',
    workspace: 'folder',
    path: String.raw`D:\work\folder`,
    connectionId: SSH,
    expected: SSH_HOST('win32')
  },
  {
    name: 'darwin client, local POSIX repo',
    client: 'darwin',
    workspace: 'repo',
    path: '/repo',
    connectionId: null,
    expected: LOCAL_REPO('darwin')
  },
  {
    name: 'darwin client, local POSIX folder',
    client: 'darwin',
    workspace: 'folder',
    path: '/work/folder',
    connectionId: null,
    expected: LOCAL_FOLDER('darwin')
  },
  {
    name: 'darwin client, SSH POSIX repo',
    client: 'darwin',
    workspace: 'repo',
    path: '/srv/repo',
    connectionId: SSH,
    expected: SSH_HOST('linux')
  },
  {
    name: 'darwin client, SSH C:\\ repo',
    client: 'darwin',
    workspace: 'repo',
    path: String.raw`C:\srv\repo`,
    connectionId: SSH,
    expected: SSH_HOST('win32')
  },
  {
    name: 'darwin client, SSH POSIX folder',
    client: 'darwin',
    workspace: 'folder',
    path: '/srv/folder',
    connectionId: SSH,
    expected: SSH_HOST('linux')
  },
  {
    name: 'darwin client, SSH C:\\ folder',
    client: 'darwin',
    workspace: 'folder',
    path: String.raw`D:\work\folder`,
    connectionId: SSH,
    expected: SSH_HOST('win32')
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (row 5 quoting platform): which host and platform an automation launch targets.
describe('row 5: resolveAgentBackgroundLaunchHost on main', () => {
  beforeAll(async () => {
    await loadForClient('win32')
    await loadForClient('darwin')
  }, 120_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(HOST_CASES)('$name', async (testCase) => {
    const { host } = await loadForClient(testCase.client)
    const isRepo = testCase.workspace === 'repo'
    const store = makeHostStore(testCase)
    expect(
      host.resolveAgentBackgroundLaunchHost({
        store,
        worktreeId: isRepo ? 'wt-1' : FOLDER_ID,
        worktreePath: testCase.path,
        repo: isRepo ? store.repos[0] : null
      })
    ).toStrictEqual(testCase.expected)
  })

  it('refuses a folder workspace whose host is ambiguous', async () => {
    const { host } = await loadForClient('darwin')
    const store = makeHostStore({
      name: 'ambiguous',
      client: 'darwin',
      workspace: 'folder',
      path: '/work/folder',
      connectionId: null,
      expected: {}
    })
    // A local repo plus an SSH repo in the same group leaves no single owner.
    Object.assign(store, {
      repos: [
        { id: 'a', connectionId: null, path: '/work/a', projectGroupId: 'grp-1' },
        { id: 'b', connectionId: SSH, path: '/srv/b', projectGroupId: 'grp-1' }
      ]
    })
    expect(() =>
      host.resolveAgentBackgroundLaunchHost({
        store,
        worktreeId: FOLDER_ID,
        worktreePath: '/work/folder',
        repo: null
      })
    ).toThrow('The target folder workspace host is unavailable or ambiguous.')
  })
})
