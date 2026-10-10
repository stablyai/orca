import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { AppState } from '@/store/types'
import { resolveAgentLaunchExecutionContext } from './launch-agent-execution-context'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLIENT_PLATFORM: 'win32'
}))

type Store = Parameters<typeof resolveAgentLaunchExecutionContext>[0]

function runtimeStatus(hostPlatform: NodeJS.Platform): RuntimeEnvironmentStatus {
  return {
    checkedAt: 1,
    status: {
      runtimeId: 'rt',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      hostPlatform
    }
  }
}

function sshState(remotePlatform?: 'linux' | 'win32'): SshConnectionState {
  return {
    targetId: 'box',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    ...(remotePlatform ? { remotePlatform } : {})
  }
}

function store(args: {
  repo: Partial<AppState['repos'][number]> & { path: string }
  worktreePath: string
  sshConnectionStates?: Map<string, SshConnectionState>
  sshStateByEnvironment?: AppState['sshStateByEnvironment']
  runtimeStatusByEnvironmentId?: Map<string, RuntimeEnvironmentStatus>
}): Store {
  const repo = {
    id: 'repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...args.repo
  }
  const worktree = {
    id: `repo::${args.worktreePath}`,
    repoId: 'repo',
    path: args.worktreePath
  }
  const state = {
    repos: [repo],
    worktreesByRepo: { repo: [worktree] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    activeRepoId: null,
    activeWorktreeId: null,
    settings: { activeRuntimeEnvironmentId: null, terminalWindowsShell: 'powershell.exe' },
    sshConnectionStates: args.sshConnectionStates ?? new Map(),
    sshStateByEnvironment: args.sshStateByEnvironment ?? new Map(),
    runtimeStatusByEnvironmentId: args.runtimeStatusByEnvironmentId ?? new Map(),
    restoredRuntimeHostIdByWorkspaceSessionKey: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test store carries every slice the resolver reads.
  return { ...state, allWorktrees: () => [worktree] } as unknown as Store
}

describe('resolveAgentLaunchExecutionContext from a Windows client', () => {
  it('quotes for the Linux Orca server that runs the agent, not the client (#22204, #12252)', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
        worktreePath: '/srv/repo',
        runtimeStatusByEnvironmentId: new Map([['linux-box', runtimeStatus('linux')]])
      }),
      { worktreeId: 'repo::/srv/repo' }
    )
    expect(context).toMatchObject({
      resolvedLaunchPlatform: 'linux',
      isRemote: false,
      queuedShell: undefined
    })
  })

  it('does not apply the client PowerShell setting to a Windows Orca server', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: 'D:\\repo', executionHostId: 'runtime:win-box' },
        worktreePath: 'D:\\repo',
        runtimeStatusByEnvironmentId: new Map([['win-box', runtimeStatus('win32')]])
      }),
      { worktreeId: 'repo::D:\\repo' }
    )
    expect(context).toMatchObject({
      resolvedLaunchPlatform: 'win32',
      queuedShell: undefined
    })
  })

  it('withholds the launch when the Orca server has never reported its OS', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
        worktreePath: '/srv/repo'
      }),
      { worktreeId: 'repo::/srv/repo' }
    )
    expect(context).toBeNull()
  })

  it('uses the SSH host OS reported by the relay for a direct SSH workspace', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: '/home/u/repo', connectionId: 'box' },
        worktreePath: '/home/u/repo',
        sshConnectionStates: new Map([['box', sshState('win32')]])
      }),
      { worktreeId: 'repo::/home/u/repo' }
    )
    expect(context).toMatchObject({
      resolvedLaunchPlatform: 'win32',
      isRemote: true
    })
  })

  it('withholds a direct SSH launch until the relay reports the host OS', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: 'C:\\repo', connectionId: 'box' },
        worktreePath: 'C:\\repo',
        sshConnectionStates: new Map([['box', sshState()]])
      }),
      { worktreeId: 'repo::C:\\repo' }
    )
    expect(context).toBeNull()
  })

  it('reads a nested SSH target from the Orca server that reaches it', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: {
          path: 'C:\\repo',
          executionHostId: 'runtime:linux-box',
          connectionId: 'box'
        },
        worktreePath: 'C:\\repo',
        sshConnectionStates: new Map([['box', sshState('win32')]]),
        sshStateByEnvironment: new Map([
          [
            'linux-box',
            {
              connectionStates: new Map([['box', sshState('linux')]]),
              targetLabels: new Map(),
              targetGenerations: new Map(),
              removedTargetLabels: new Map(),
              targetsHydrated: true
            }
          ]
        ]),
        runtimeStatusByEnvironmentId: new Map([['linux-box', runtimeStatus('win32')]])
      }),
      { worktreeId: 'repo::C:\\repo' }
    )
    expect(context).toMatchObject({
      resolvedLaunchPlatform: 'linux',
      isRemote: true
    })
  })

  it('keeps the client shell setting for a local workspace', () => {
    const context = resolveAgentLaunchExecutionContext(
      store({ repo: { path: 'C:\\repo' }, worktreePath: 'C:\\repo' }),
      { worktreeId: 'repo::C:\\repo' }
    )
    expect(context).toMatchObject({
      resolvedLaunchPlatform: 'win32',
      queuedShell: 'powershell'
    })
  })

  it('reads a folder workspace path so a WSL folder on a Windows server quotes for Linux', () => {
    const base = store({
      repo: { path: '/unused' },
      worktreePath: '/unused',
      runtimeStatusByEnvironmentId: new Map([['win-box', runtimeStatus('win32')]])
    })
    const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    const context = resolveAgentLaunchExecutionContext(
      Object.assign(base, {
        folderWorkspaces: [
          { id: 'f1', projectGroupId: 'g1', connectionId: null, executionHostId: 'runtime:win-box' }
        ],
        projectGroups: [{ id: 'g1', connectionId: null, executionHostId: 'runtime:win-box' }],
        getKnownWorktreeById: () => ({ path: folderPath })
      }),
      { worktreeId: 'folder:f1' }
    )
    expect(context).toMatchObject({ resolvedLaunchPlatform: 'linux', queuedShell: undefined })
  })

  it("ignores a caller's client platform for a workspace on a Linux server", () => {
    const context = resolveAgentLaunchExecutionContext(
      store({
        repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
        worktreePath: '/srv/repo',
        runtimeStatusByEnvironmentId: new Map([['linux-box', runtimeStatus('linux')]])
      }),
      { worktreeId: 'repo::/srv/repo', launchPlatform: 'win32' }
    )
    expect(context).toMatchObject({ resolvedLaunchPlatform: 'linux', queuedShell: undefined })
  })

  it("keeps a caller's platform for a local launch", () => {
    const context = resolveAgentLaunchExecutionContext(
      store({ repo: { path: 'C:\\repo' }, worktreePath: 'C:\\repo' }),
      { worktreeId: 'repo::C:\\repo', launchPlatform: 'linux' }
    )
    expect(context).toMatchObject({ resolvedLaunchPlatform: 'linux', queuedShell: undefined })
  })
})
