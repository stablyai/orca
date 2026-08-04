import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  findRuntimeWorkspaceFileRoute,
  findWorkspaceFileRoute
} from './runtime-workspace-file-route'

function state(): AppState {
  return {
    settings: { activeRuntimeEnvironmentId: 'runtime-a' },
    repos: [],
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      repoA: [
        {
          id: 'repo-a::/srv/repo-a',
          repoId: 'repo-a',
          path: '/srv/repo-a',
          runtimeOwnerEnvironmentId: 'runtime-a'
        }
      ],
      repoB: [
        {
          id: 'repo-b::/srv/repo-b',
          repoId: 'repo-b',
          path: '/srv/repo-b',
          runtimeOwnerEnvironmentId: 'runtime-a'
        },
        {
          id: 'repo-b::/srv/repo-b/docs',
          repoId: 'repo-b',
          path: '/srv/repo-b/docs',
          runtimeOwnerEnvironmentId: 'runtime-b'
        }
      ]
    },
    folderWorkspaces: [
      {
        id: 'notes',
        projectGroupId: 'group-a',
        folderPath: '/srv/notes',
        connectionId: null
      }
    ],
    projectGroups: [
      {
        id: 'group-a',
        connectionId: null,
        executionHostId: 'runtime:runtime-a'
      }
    ]
  } as unknown as AppState
}

describe('findRuntimeWorkspaceFileRoute', () => {
  it('routes a file through its sibling worktree on the same runtime', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/repo-b/src/index.ts')).toEqual(
      {
        worktreeId: 'repo-b::/srv/repo-b',
        relativePath: 'src/index.ts',
        executionHostId: 'runtime:runtime-a'
      }
    )
  })

  it('does not use a more specific workspace owned by another runtime', () => {
    expect(
      findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/repo-b/docs/guide.md')
    ).toEqual({
      worktreeId: 'repo-b::/srv/repo-b',
      relativePath: 'docs/guide.md',
      executionHostId: 'runtime:runtime-a'
    })
  })

  it('includes folder workspaces owned by the runtime', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/notes/todo.md')).toEqual({
      worktreeId: 'folder:notes',
      relativePath: 'todo.md',
      executionHostId: 'runtime:runtime-a'
    })
  })

  it('rejects paths outside every workspace owned by the runtime', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/etc/passwd')).toBeNull()
  })

  it('does not route workspace directories as editor files', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/repo-b')).toBeNull()
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/notes')).toBeNull()
  })

  it('routes duplicate worktree ids through their exact execution host', () => {
    const duplicateState = state()
    duplicateState.repos = [
      { id: 'shared-repo', executionHostId: 'local' },
      { id: 'shared-repo', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
    ] as never
    duplicateState.worktreesByRepo = {
      sharedRepo: [
        {
          id: 'shared-worktree',
          repoId: 'shared-repo',
          path: '/local/shared-repo',
          hostId: 'local'
        },
        {
          id: 'shared-worktree',
          repoId: 'shared-repo',
          path: '/srv/shared-repo',
          hostId: 'ssh:ssh-1'
        }
      ]
    } as never
    duplicateState.folderWorkspaces = []

    expect(
      findWorkspaceFileRoute(duplicateState, 'local', '/local/shared-repo/src/local.ts')
    ).toEqual({
      worktreeId: 'shared-worktree',
      relativePath: 'src/local.ts',
      executionHostId: 'local'
    })
    expect(
      findWorkspaceFileRoute(duplicateState, 'ssh:ssh-1', '/srv/shared-repo/src/remote.ts')
    ).toEqual({
      worktreeId: 'shared-worktree',
      relativePath: 'src/remote.ts',
      executionHostId: 'ssh:ssh-1'
    })
    expect(
      findWorkspaceFileRoute(duplicateState, 'local', '/srv/shared-repo/src/remote.ts')
    ).toBeNull()
    expect(
      findWorkspaceFileRoute(duplicateState, 'ssh:ssh-1', '/local/shared-repo/src/local.ts')
    ).toBeNull()
  })

  it('routes paired duplicate ids through their logical runtime owner', () => {
    const duplicateState = state()
    duplicateState.repos = [
      { id: 'shared-repo', executionHostId: 'local' },
      {
        id: 'shared-repo',
        connectionId: 'builder',
        executionHostId: 'runtime:runtime-a'
      }
    ] as never
    duplicateState.worktreesByRepo = {
      sharedRepo: [
        {
          id: 'shared-worktree',
          repoId: 'shared-repo',
          path: '/local/shared-repo',
          hostId: 'local'
        },
        {
          id: 'shared-worktree',
          repoId: 'shared-repo',
          path: '/srv/shared-repo',
          hostId: 'ssh:builder',
          runtimeOwnerEnvironmentId: 'runtime-a'
        }
      ]
    } as never
    duplicateState.folderWorkspaces = []

    expect(
      findRuntimeWorkspaceFileRoute(duplicateState, 'runtime-a', '/srv/shared-repo/src/remote.ts')
    ).toEqual({
      worktreeId: 'shared-worktree',
      relativePath: 'src/remote.ts',
      executionHostId: 'runtime:runtime-a'
    })
    expect(
      findRuntimeWorkspaceFileRoute(duplicateState, 'runtime-a', '/local/shared-repo/src/local.ts')
    ).toBeNull()
  })

  it('routes direct SSH siblings only on the exact SSH host', () => {
    const sshState = state()
    sshState.repos = [
      { id: 'repo-a', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' },
      { id: 'repo-b', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' },
      { id: 'repo-c', connectionId: 'ssh-2', executionHostId: 'ssh:ssh-2' }
    ] as never
    sshState.worktreesByRepo = {
      repoA: [{ id: 'a', repoId: 'repo-a', path: '/srv/a', hostId: 'ssh:ssh-1' }],
      repoB: [{ id: 'b', repoId: 'repo-b', path: '/srv/b', hostId: 'ssh:ssh-1' }],
      repoC: [{ id: 'c', repoId: 'repo-c', path: '/srv/b/nested', hostId: 'ssh:ssh-2' }]
    } as never
    sshState.folderWorkspaces = []

    expect(findWorkspaceFileRoute(sshState, 'ssh:ssh-1', '/srv/b/nested/file.ts')).toEqual({
      worktreeId: 'b',
      relativePath: 'nested/file.ts',
      executionHostId: 'ssh:ssh-1'
    })
    expect(findWorkspaceFileRoute(sshState, 'ssh:ssh-2', '/srv/a/file.ts')).toBeNull()
  })
})
