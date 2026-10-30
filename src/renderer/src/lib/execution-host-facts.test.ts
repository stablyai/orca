import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import {
  resolveExecutionHostAgentStartupShell,
  resolveRepoExecutionHostPlatform,
  resolveRepoWorktreeLaunchPlatform
} from './execution-host-facts'
import { getDefaultSettings } from '../../../shared/constants'

vi.mock('./new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLIENT_PLATFORM: 'win32'
}))

type State = Parameters<typeof resolveRepoWorktreeLaunchPlatform>[0]

function linuxServer(): Map<string, RuntimeEnvironmentStatus> {
  return new Map([
    [
      'linux-box',
      {
        checkedAt: 1,
        status: {
          runtimeId: 'rt',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          hostPlatform: 'linux'
        }
      }
    ]
  ])
}

function state(): State {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    activeRepoId: null,
    activeWorktreeId: null,
    settings: getDefaultSettings('/tmp'),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: linuxServer()
  }
}

const serverRepo = { path: '/srv/repo', executionHostId: 'runtime:linux-box' }

describe('resolveRepoWorktreeLaunchPlatform from a Windows client', () => {
  it("reads a server project's worktree as the server's OS (#27971)", () => {
    expect(
      resolveRepoWorktreeLaunchPlatform(state(), serverRepo, { id: 'wt', path: '/srv/wt' })
    ).toBe('linux')
  })

  it("lets a worktree's own host outrank its repo's", () => {
    expect(
      resolveRepoWorktreeLaunchPlatform(state(), serverRepo, {
        id: 'wt',
        path: 'C:\\wt',
        hostId: 'local'
      })
    ).toBe('win32')
  })

  it("reads a server-projected SSH worktree through that server's connection", () => {
    const nested = {
      ...state(),
      sshStateByEnvironment: new Map([
        [
          'linux-box',
          {
            connectionStates: new Map([
              [
                'box',
                {
                  targetId: 'box',
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  remotePlatform: 'linux' as const
                }
              ]
            ]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    }
    expect(
      resolveRepoWorktreeLaunchPlatform(nested, serverRepo, {
        id: 'wt',
        path: '/home/a/wt',
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: 'linux-box'
      })
    ).toBe('linux')
  })

  it('is undefined when the server has not reported its OS', () => {
    const withheld = { ...state(), runtimeStatusByEnvironmentId: new Map() }
    expect(
      resolveRepoWorktreeLaunchPlatform(withheld, serverRepo, { id: 'wt', path: '/srv/wt' })
    ).toBeUndefined()
  })
})

// Why: a desktop-built command runs in the server's own Windows shell, as resume quoting assumes.
describe('resolveExecutionHostAgentStartupShell for a paired Windows server', () => {
  it.each([
    ['cmd.exe', 'cmd'],
    ['git-bash', 'posix'],
    [undefined, undefined]
  ] as const)('quotes for a server whose shell is %s as %s', (serverShell, expected) => {
    const fact = {
      kind: 'known' as const,
      platform: 'win32' as const,
      hostKind: 'runtime' as const,
      ...(serverShell ? { terminalWindowsShell: serverShell } : {})
    }
    expect(resolveExecutionHostAgentStartupShell(fact, 'powershell.exe')).toBe(expected)
  })

  it('reads the shell the server reported into its host fact', () => {
    const windowsServer = new Map(
      [...linuxServer()].map(([id, entry]) => [
        id,
        {
          ...entry,
          status: entry.status && {
            ...entry.status,
            hostPlatform: 'win32' as const,
            terminalWindowsShell: 'cmd.exe'
          }
        }
      ])
    )
    expect(
      resolveRepoExecutionHostPlatform(
        { ...state(), runtimeStatusByEnvironmentId: windowsServer },
        serverRepo,
        () => undefined
      )
    ).toEqual({
      kind: 'known',
      platform: 'win32',
      hostKind: 'runtime',
      terminalWindowsShell: 'cmd.exe'
    })
  })
})
