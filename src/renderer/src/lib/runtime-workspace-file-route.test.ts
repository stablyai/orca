import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { findRuntimeWorkspaceFileRoute } from './runtime-workspace-file-route'

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
        relativePath: 'src/index.ts'
      }
    )
  })

  it('does not use a more specific workspace owned by another runtime', () => {
    expect(
      findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/repo-b/docs/guide.md')
    ).toEqual({
      worktreeId: 'repo-b::/srv/repo-b',
      relativePath: 'docs/guide.md'
    })
  })

  it('includes folder workspaces owned by the runtime', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/srv/notes/todo.md')).toEqual({
      worktreeId: 'folder:notes',
      relativePath: 'todo.md'
    })
  })

  it('rejects paths outside every workspace owned by the runtime', () => {
    expect(findRuntimeWorkspaceFileRoute(state(), 'runtime-a', '/etc/passwd')).toBeNull()
  })
})
