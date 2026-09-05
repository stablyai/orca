import { describe, expect, it } from 'vitest'
import { resolveAgentBackgroundLaunchHost } from './agent-background-session-launch-host'

function makeFolderHostState(args: {
  connectionId: string | null
  folderPath: string
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
        connectionId: args.connectionId
      }
    ],
    projectGroups: [
      {
        id: 'group-1',
        parentGroupId: null,
        connectionId: args.connectionId
      }
    ],
    repos: args.repos ?? []
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

    expect(host).toMatchObject({ connectionId: 'nested', isRemote: true })
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
