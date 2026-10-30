import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import {
  findRuntimeWorkspaceFileRoute,
  findWorkspaceFileRoute
} from './runtime-workspace-file-route'

function state(): AppState {
  const store = createTestStore()
  store.setState({
    settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'runtime-a' }),
    repos: [],
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      'repo-a': [
        makeWorktree({
          id: 'repo-a::/srv/repo-a',
          repoId: 'repo-a',
          path: '/srv/repo-a',
          runtimeOwnerEnvironmentId: 'runtime-a'
        })
      ],
      'repo-b': [
        makeWorktree({
          id: 'repo-b::/srv/repo-b',
          repoId: 'repo-b',
          path: '/srv/repo-b',
          runtimeOwnerEnvironmentId: 'runtime-a'
        }),
        makeWorktree({
          id: 'repo-b::/srv/repo-b/docs',
          repoId: 'repo-b',
          path: '/srv/repo-b/docs',
          runtimeOwnerEnvironmentId: 'runtime-b'
        })
      ]
    },
    folderWorkspaces: [
      makeFolderWorkspace({
        id: 'notes',
        projectGroupId: 'group-a',
        folderPath: '/srv/notes',
        connectionId: null
      })
    ],
    projectGroups: [
      {
        id: 'group-a',
        name: 'Group A',
        parentPath: '/srv',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0,
        connectionId: null,
        executionHostId: 'runtime:runtime-a'
      }
    ]
  })
  return store.getState()
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

  it('routes direct SSH siblings only on the exact SSH host', () => {
    const sshState = state()
    sshState.repos = [
      { ...TEST_REPO, id: 'repo-a', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' },
      { ...TEST_REPO, id: 'repo-b', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' },
      { ...TEST_REPO, id: 'repo-c', connectionId: 'ssh-2', executionHostId: 'ssh:ssh-2' }
    ]
    sshState.worktreesByRepo = {
      'repo-a': [makeWorktree({ id: 'a', repoId: 'repo-a', path: '/srv/a', hostId: 'ssh:ssh-1' })],
      'repo-b': [makeWorktree({ id: 'b', repoId: 'repo-b', path: '/srv/b', hostId: 'ssh:ssh-1' })],
      'repo-c': [
        makeWorktree({ id: 'c', repoId: 'repo-c', path: '/srv/b/nested', hostId: 'ssh:ssh-2' })
      ]
    }
    sshState.folderWorkspaces = []

    expect(findWorkspaceFileRoute(sshState, 'ssh:ssh-1', '/srv/b/nested/file.ts')).toEqual({
      worktreeId: 'b',
      relativePath: 'nested/file.ts',
      executionHostId: 'ssh:ssh-1'
    })
    expect(findWorkspaceFileRoute(sshState, 'ssh:ssh-2', '/srv/a/file.ts')).toBeNull()
  })
})
