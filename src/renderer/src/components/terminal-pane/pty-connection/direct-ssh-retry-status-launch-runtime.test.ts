import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as InstallerModuleNamespace from './direct-ssh-retry-status'
import type * as CapabilitiesModule from '@/lib/windows-terminal-capabilities'

type Client = 'win32' | 'darwin'
type InstallerModule = typeof InstallerModuleNamespace

const USER_AGENT: Record<Client, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca'
}
const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`
const HOST_PATH = String.raw`C:\Users\alice\repo`
const WORKTREE_ID = 'repo-1::worktree'
const FOLDER_ID = 'folder:fw-1'
const WSL_CAPABILITIES = {
  wslAvailable: true,
  wslDistros: ['Ubuntu'],
  pwshAvailable: false,
  gitBashAvailable: false
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ agentStatusByPaneKey: {} }), subscribe: () => () => {} }
}))

vi.mock('@/lib/windows-terminal-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof CapabilitiesModule>()),
  hasCachedWindowsTerminalCapabilities: () => true,
  getCachedWindowsTerminalCapabilities: () => WSL_CAPABILITIES
}))

const installerByClient = new Map<Client, InstallerModule>()

async function loadInstallerForClient(client: Client): Promise<InstallerModule> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = installerByClient.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const installer = await import('./direct-ssh-retry-status')
  installerByClient.set(client, installer)
  return installer
}

function makeState(args: { workspace: 'repo' | 'folder'; path: string; folderInRepo?: boolean }) {
  const repoPath = args.workspace === 'folder' && args.folderInRepo ? args.path : '/elsewhere'
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    agentStatusByPaneKey: {},
    settings: { terminalWindowsShell: 'powershell.exe' },
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    repos: [
      {
        id: 'repo-1',
        path: args.workspace === 'repo' ? args.path : repoPath,
        connectionId: null,
        displayName: 'repo'
      }
    ],
    worktreesByRepo:
      args.workspace === 'repo'
        ? { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', path: args.path }] }
        : {},
    folderWorkspaces: [
      {
        id: 'fw-1',
        projectGroupId: 'pg-1',
        name: 'folder',
        folderPath: args.path,
        connectionId: null
      }
    ],
    projectGroups: [{ id: 'pg-1', name: 'group', parentPath: null, parentGroupId: null }]
  }
}

function makeSession(args: {
  state: ReturnType<typeof makeState>
  worktreeId: string
  cwd: string
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  tab?: { forceHostRuntime?: boolean; shellOverride?: string }
  delivery?: 'terminal-paste'
}): Record<string, unknown> {
  return {
    state: args.state,
    tab: args.tab ?? null,
    terminalOwnerUnresolved: false,
    connectionId: args.connectionId ?? null,
    runtimeEnvironmentId: args.runtimeEnvironmentId ?? null,
    cacheKey: 'tab-1:leaf-1',
    paneStartup: { command: 'claude', ...(args.delivery ? { delivery: args.delivery } : {}) },
    pane: { terminal: {} },
    deps: {
      worktreeId: args.worktreeId,
      cwd: args.cwd,
      paneTransportsRef: { current: new Map() }
    }
  }
}

function install(installer: InstallerModule, session: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bag names every member the installer reads before it assigns its own fields; the rest are written, not read.
  installer.installDirectSshRetryStatus(session as never)
  return session
}

// Pins main's current launch behaviour as the convergence parity baseline (rule WINDOW_PANE; serves
// every window-pane producer, rows 1, 2 and 6): the projectRuntime a pane sends on pty:spawn.
describe('WINDOW_PANE: the pane projectRuntime on main', () => {
  // Why: the first import transforms the whole pane graph; keep that out of the first case.
  beforeAll(async () => {
    await loadInstallerForClient('win32')
    await loadInstallerForClient('darwin')
  }, 120_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    // workspace, path, projectRuntime kind (undefined = none sent)
    ['repo', WSL_PATH, 'wsl'],
    ['repo', HOST_PATH, 'windows-host'],
    ['folder', WSL_PATH, undefined],
    ['folder', HOST_PATH, undefined]
  ] as const)('Windows client, local %s at %s sends %s', async (workspace, path, kind) => {
    const installer = await loadInstallerForClient('win32')
    const worktreeId = workspace === 'repo' ? WORKTREE_ID : FOLDER_ID
    const session = install(
      installer,
      makeSession({ state: makeState({ workspace, path }), worktreeId, cwd: path })
    )

    expect(session.localWindowsTerminalCapabilities).toEqual(WSL_CAPABILITIES)
    if (kind === undefined) {
      expect(session.projectRuntime).toBeUndefined()
      return
    }
    expect(session.projectRuntime).toMatchObject({ status: 'resolved', runtime: { kind } })
  })

  it('a Windows folder pane inside exactly one local repo resolves through that repo', async () => {
    const installer = await loadInstallerForClient('win32')
    const state = makeState({ workspace: 'folder', path: WSL_PATH, folderInRepo: true })
    const session = install(installer, makeSession({ state, worktreeId: FOLDER_ID, cwd: WSL_PATH }))

    expect(session.projectRuntime).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'repo-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'repo-1:wsl:Ubuntu'
      }
    })
  })

  it.each([
    ['repo', WSL_PATH],
    ['repo', HOST_PATH],
    ['folder', WSL_PATH],
    ['folder', HOST_PATH]
  ] as const)('macOS client, local %s at %s sends no projectRuntime', async (workspace, path) => {
    const installer = await loadInstallerForClient('darwin')
    const worktreeId = workspace === 'repo' ? WORKTREE_ID : FOLDER_ID
    const session = install(
      installer,
      makeSession({ state: makeState({ workspace, path }), worktreeId, cwd: path })
    )

    expect(session.projectRuntime).toBeUndefined()
  })

  it.each([
    ['tab.forceHostRuntime', { tab: { forceHostRuntime: true } }],
    ['an SSH connection', { connectionId: 'ssh-1' }],
    ['a paired runtime', { runtimeEnvironmentId: 'env-1' }]
  ] as const)('a Windows WSL repo pane with %s sends no projectRuntime', async (_label, extra) => {
    const installer = await loadInstallerForClient('win32')
    const state = makeState({ workspace: 'repo', path: WSL_PATH })
    const session = install(
      installer,
      makeSession({ state, worktreeId: WORKTREE_ID, cwd: WSL_PATH, ...extra })
    )

    expect(session.projectRuntime).toBeUndefined()
  })

  it.each([
    // connectionId, startup delivery, uses the provider's SSH startup delivery
    [null, undefined, false],
    ['ssh-1', undefined, true],
    ['ssh-1', 'terminal-paste', false]
  ] as const)(
    'SSH %s with %s startup delivery uses provider delivery: %s',
    async (connectionId, delivery, expected) => {
      const installer = await loadInstallerForClient('darwin')
      const state = makeState({ workspace: 'repo', path: '/home/alice/repo' })
      const session = install(
        installer,
        makeSession({
          state,
          worktreeId: WORKTREE_ID,
          cwd: '/home/alice/repo',
          connectionId,
          ...(delivery ? { delivery } : {})
        })
      )

      expect(session.shouldUseProviderSshStartupDelivery).toBe(expected)
    }
  )

  it('the pane shell is the tab shellOverride', async () => {
    const installer = await loadInstallerForClient('win32')
    const state = makeState({ workspace: 'repo', path: HOST_PATH })
    const session = install(
      installer,
      makeSession({
        state,
        worktreeId: WORKTREE_ID,
        cwd: HOST_PATH,
        tab: { shellOverride: 'cmd.exe' }
      })
    )

    expect(session.shellOverride).toBe('cmd.exe')
  })
})
