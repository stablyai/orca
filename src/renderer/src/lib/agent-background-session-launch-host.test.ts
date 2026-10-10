import { describe, expect, it } from 'vitest'
import { resolveAgentBackgroundLaunchHost } from './agent-background-session-launch-host'

function sshState(remotePlatform: 'linux' | 'win32') {
  return { status: 'connected', error: null, reconnectAttempt: 0, remotePlatform }
}

function runtimeStatus(hostPlatform: NodeJS.Platform) {
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

type LaunchStore = Parameters<typeof resolveAgentBackgroundLaunchHost>[0]['store']
type LaunchRepo = Parameters<typeof resolveAgentBackgroundLaunchHost>[0]['repo']

function asLaunchInputs(store: unknown, repo: unknown): { store: LaunchStore; repo: LaunchRepo } {
  const withRepo = repo ? Object.assign({}, store, { repos: [repo] }) : store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures carry every slice and repo field the host resolver reads.
  return { store: withRepo as LaunchStore, repo: repo as LaunchRepo }
}

function makeFolderHostState(args: {
  connectionId: string | null
  folderPath: string
  folderExecutionHostId?: string
  repos?: {
    id: string
    connectionId: string | null
    path: string
    projectGroupId: string
  }[]
}) {
  return {
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        folderPath: args.folderPath,
        connectionId: args.connectionId,
        executionHostId: args.folderExecutionHostId ?? null
      }
    ],
    projectGroups: [
      {
        id: 'group-1',
        parentGroupId: null,
        connectionId: args.connectionId,
        executionHostId: args.folderExecutionHostId ?? null
      }
    ],
    repos: args.repos ?? [],
    worktreesByRepo: {},
    sshConnectionStates: new Map([
      ['m4air', sshState('linux')],
      ['openclaw', sshState('linux')],
      ['nested', sshState('win32')]
    ]),
    sshStateByEnvironment: new Map([
      ['vm-1', { connectionStates: new Map([['nested', sshState('linux')]]) }]
    ]),
    runtimeStatusByEnvironmentId: new Map([['linux-box', runtimeStatus('linux')]])
  }
}

describe('resolveAgentBackgroundLaunchHost', () => {
  it('keeps an authoritative local folder owner local', () => {
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'folder:folder-1',
      worktreePath: '/project',
      repo: null
    })

    expect(host).toMatchObject({
      connectionId: null,
      isRemote: false,
      expectedConnectionId: null
    })
  })

  it('fails closed when folder ownership is ambiguous', () => {
    const store = makeFolderHostState({
      connectionId: 'ssh-1',
      folderPath: '/project',
      repos: [
        {
          id: 'repo-local',
          connectionId: null,
          path: '/project/repo',
          projectGroupId: 'group-1'
        }
      ]
    })

    expect(() =>
      resolveAgentBackgroundLaunchHost({
        store: store as never,
        worktreeId: 'folder:folder-1',
        worktreePath: '/project',
        repo: null
      })
    ).toThrow('unavailable or ambiguous')
  })

  // Why two hosts: a single-SSH fixture passes even when the route is read off another host's
  // row, which is the shape of the `ssh:m4air` -> openclaw leak.
  it('routes both spellings of SSH ownership to their own host', () => {
    const legacy = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo',
      repo: {
        id: 'repo-1',
        connectionId: 'm4air',
        executionHostId: null,
        path: '/srv/repo'
      } as never
    })
    const unified = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo',
      repo: {
        id: 'repo-1',
        connectionId: null,
        executionHostId: 'ssh:openclaw',
        path: '/srv/repo'
      } as never
    })

    expect(legacy).toMatchObject({
      connectionId: 'm4air',
      isRemote: true,
      expectedConnectionId: 'm4air'
    })
    expect(unified).toMatchObject({
      connectionId: 'openclaw',
      isRemote: true,
      expectedConnectionId: 'openclaw'
    })
  })

  it('keeps a local row with a stale connection off the SSH route', () => {
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo',
      repo: {
        id: 'repo-1',
        connectionId: 'm4air',
        executionHostId: 'local',
        path: '/srv/repo'
      } as never
    })

    expect(host).toMatchObject({
      connectionId: null,
      isRemote: false,
      expectedConnectionId: null
    })
  })

  it('keeps a runtime host reaching a nested SSH target remote', () => {
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo',
      repo: {
        id: 'repo-1',
        connectionId: 'nested',
        executionHostId: 'runtime:vm-1',
        path: '/srv/repo'
      } as never
    })

    // Why linux: the runtime's own SSH state for the target wins over the client's same-named one.
    expect(host).toMatchObject({ connectionId: 'nested', isRemote: true, platform: 'linux' })
  })

  it('quotes for the Orca server that owns a repo, not the client (#22204)', () => {
    const host = resolveAgentBackgroundLaunchHost({
      ...asLaunchInputs(makeFolderHostState({ connectionId: null, folderPath: '/project' }), {
        id: 'repo-1',
        connectionId: null,
        executionHostId: 'runtime:linux-box',
        path: '/srv/repo'
      }),
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo'
    })

    expect(host).toMatchObject({ connectionId: null, isRemote: false, platform: 'linux' })
  })

  it("uses a worktree's nested SSH host over its repo's runtime default", () => {
    const state = {
      ...makeFolderHostState({ connectionId: null, folderPath: '/project' }),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::/srv/repo',
            repoId: 'repo-1',
            hostId: 'ssh:nested',
            runtimeOwnerEnvironmentId: 'vm-1'
          }
        ]
      },
      runtimeStatusByEnvironmentId: new Map([['vm-1', runtimeStatus('win32')]])
    }
    const host = resolveAgentBackgroundLaunchHost({
      ...asLaunchInputs(state, {
        id: 'repo-1',
        connectionId: null,
        executionHostId: 'runtime:vm-1',
        path: '/srv/repo'
      }),
      worktreeId: 'repo-1::/srv/repo',
      worktreePath: '/srv/repo'
    })

    // Why isRemote: the SSH target runs the relay shim as `orca`, not the Linux desktop `orca-ide`.
    expect(host).toMatchObject({ platform: 'linux', isLocalHost: false, isRemote: true })
  })

  it('quotes for the Orca server that owns a folder workspace', () => {
    const host = resolveAgentBackgroundLaunchHost({
      ...asLaunchInputs(
        makeFolderHostState({
          connectionId: null,
          folderPath: '/project',
          folderExecutionHostId: 'runtime:linux-box'
        }),
        null
      ),
      worktreeId: 'folder:folder-1',
      worktreePath: '/project'
    })

    expect(host.platform).toBe('linux')
  })

  it('refuses a launch whose SSH host never reported its OS', () => {
    expect(() =>
      resolveAgentBackgroundLaunchHost({
        ...asLaunchInputs(
          {
            ...makeFolderHostState({ connectionId: null, folderPath: '/project' }),
            repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'ssh:silent' }]
          },
          {
            id: 'repo-1',
            connectionId: null,
            executionHostId: 'ssh:silent',
            path: '/srv/repo'
          }
        ),
        worktreeId: 'repo-1::/srv/repo',
        worktreePath: '/srv/repo'
      })
    ).toThrow('has not reported its operating system')
  })

  it('uses Linux startup quoting for a local WSL folder', () => {
    const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath }) as never,
      worktreeId: 'folder:folder-1',
      worktreePath: folderPath,
      repo: null
    })

    expect(host.platform).toBe('linux')
  })
})
