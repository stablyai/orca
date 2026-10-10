import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { useAppStore } from '@/store'
import type * as PlannerModuleNamespace from './launch-agent-execution-context'

type PlannerStore = ReturnType<typeof useAppStore.getState>
type Client = 'win32' | 'darwin'
type Workspace = 'repo' | 'folder'

const USER_AGENT: Record<Client, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca'
}
const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`
const HOST_PATH = String.raw`C:\Users\alice\repo`
const WORKTREE_ID = 'repo-1::worktree'
const FOLDER_ID = 'folder:fw-1'

function makeStore(args: {
  workspace: Workspace
  path: string
  connectionId?: string | null
}): PlannerStore {
  const connectionId = args.connectionId ?? null
  const worktreesByRepo =
    args.workspace === 'repo'
      ? { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', path: args.path }] }
      : {}
  const store = {
    activeRepoId: null,
    activeWorktreeId: null,
    settings: { terminalWindowsShell: 'powershell.exe' },
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    repos:
      args.workspace === 'repo'
        ? [{ id: 'repo-1', path: args.path, connectionId, displayName: 'repo' }]
        : [],
    worktreesByRepo,
    allWorktrees: () => Object.values(worktreesByRepo).flat(),
    folderWorkspaces: [
      {
        id: 'fw-1',
        projectGroupId: 'pg-1',
        name: 'folder',
        folderPath: args.path,
        connectionId
      }
    ],
    projectGroups: [{ id: 'pg-1', name: 'group', parentPath: null, parentGroupId: null }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only allWorktrees, repos, projects, settings, worktreesByRepo, folderWorkspaces and projectGroups, all present here.
  return store as unknown as PlannerStore
}

type PlannerModule = typeof PlannerModuleNamespace
const plannerByClient = new Map<Client, PlannerModule>()

async function loadPlannerForClient(client: Client): Promise<PlannerModule> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = plannerByClient.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const planner = await import('./launch-agent-execution-context')
  plannerByClient.set(client, planner)
  return planner
}

// Pins main's current launch behaviour as the convergence parity baseline (rule WINDOW_PLANNER;
// serves "+" and typed-prompt new tabs, rows 1-2): which platform the window quotes for.
describe('WINDOW_PLANNER: resolveAgentLaunchExecutionContext on main', () => {
  // Why: the first import transforms the whole store graph; keep that out of the first case.
  beforeAll(async () => {
    await loadPlannerForClient('win32')
    await loadPlannerForClient('darwin')
  }, 120_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    // client, workspace, path, quoting platform, queued Windows startup shell
    ['win32', 'repo', WSL_PATH, 'linux', undefined],
    ['win32', 'repo', HOST_PATH, 'win32', 'powershell'],
    // A folder workspace has no row in allWorktrees, so the window quotes for the client.
    ['win32', 'folder', WSL_PATH, 'win32', 'powershell'],
    ['win32', 'folder', HOST_PATH, 'win32', 'powershell'],
    ['darwin', 'repo', WSL_PATH, 'darwin', undefined],
    ['darwin', 'repo', HOST_PATH, 'darwin', undefined],
    ['darwin', 'folder', WSL_PATH, 'darwin', undefined],
    ['darwin', 'folder', HOST_PATH, 'darwin', undefined]
  ] as const)(
    '%s client, local %s at %s quotes for %s',
    async (client, workspace, path, platform, queuedShell) => {
      const { resolveAgentLaunchExecutionContext } = await loadPlannerForClient(client)
      const worktreeId = workspace === 'repo' ? WORKTREE_ID : FOLDER_ID

      expect(
        resolveAgentLaunchExecutionContext(makeStore({ workspace, path }), {
          worktreeId
        })
      ).toEqual({
        worktreeSshConnectionId: null,
        resolvedLaunchPlatform: platform,
        isRemote: false,
        queuedShell
      })
    }
  )

  it.each([
    // client, workspace, remote path, quoting platform
    ['win32', 'repo', '/home/alice/repo', 'linux'],
    ['win32', 'repo', HOST_PATH, 'win32'],
    ['darwin', 'repo', '/home/alice/repo', 'linux'],
    // Folder workspaces still fall back to the client platform over SSH.
    ['win32', 'folder', '/home/alice/repo', 'win32'],
    ['darwin', 'folder', '/home/alice/repo', 'darwin']
  ] as const)(
    '%s client, SSH %s at %s quotes for %s with no Windows startup shell',
    async (client, workspace, path, platform) => {
      const { resolveAgentLaunchExecutionContext } = await loadPlannerForClient(client)
      const worktreeId = workspace === 'repo' ? WORKTREE_ID : FOLDER_ID
      const store = makeStore({ workspace, path, connectionId: 'ssh-1' })

      expect(resolveAgentLaunchExecutionContext(store, { worktreeId })).toEqual({
        worktreeSshConnectionId: 'ssh-1',
        resolvedLaunchPlatform: platform,
        isRemote: true,
        queuedShell: undefined
      })
    }
  )

  it('an explicit launchPlatform wins over every store rule', async () => {
    const { resolveAgentLaunchExecutionContext } = await loadPlannerForClient('darwin')
    const store = makeStore({ workspace: 'repo', path: HOST_PATH })

    expect(
      resolveAgentLaunchExecutionContext(store, {
        worktreeId: WORKTREE_ID,
        launchPlatform: 'win32'
      })
    ).toEqual({
      worktreeSshConnectionId: null,
      resolvedLaunchPlatform: 'win32',
      isRemote: false,
      queuedShell: 'powershell'
    })
  })
})
