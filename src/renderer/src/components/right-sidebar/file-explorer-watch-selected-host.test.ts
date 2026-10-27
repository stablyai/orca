import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import { getFileExplorerWatchRuntimeEnvironmentId } from './useFileExplorerWatch'
import type { FileExplorerOperationOwner } from './file-explorer-types'

type WatchState = Parameters<typeof getFileExplorerWatchRuntimeEnvironmentId>[0] &
  Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>

const hosts = ['host-a', 'host-b'] as const
function makeState(workspace: 'worktree' | 'folder', selected: (typeof hosts)[number]): WatchState {
  const id = workspace === 'folder' ? 'folder:same-folder' : 'same-worktree'
  return {
    settings: getDefaultSettings('/home/me'),
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: `runtime:${selected}`,
    repos: [],
    worktreesByRepo:
      workspace === 'worktree'
        ? {
            repo: hosts.map((host) =>
              makeWorktree({ id, repoId: 'repo', path: '/repo', hostId: `runtime:${host}` })
            )
          }
        : {},
    folderWorkspaces:
      workspace === 'folder'
        ? hosts.map((host) =>
            makeFolderWorkspace({
              id: 'same-folder',
              folderPath: '/folder',
              executionHostId: `runtime:${host}`
            })
          )
        : [],
    projectGroups: []
  }
}
function owner(environmentId: string): FileExplorerOperationOwner {
  return { kind: 'runtime', environmentId, executionHostId: `runtime:${environmentId}` }
}

describe('explorer watcher preserving the selected host', () => {
  it.each(['worktree', 'folder'] as const)(
    'resolves the selected %s owner when IDs repeat across hosts',
    (workspace) => {
      for (const host of hosts) {
        const state = makeState(workspace, host)
        expect(
          getFileExplorerWatchRuntimeEnvironmentId(state, state.activeWorktreeId, owner(host))
        ).toBe(host)
      }
    }
  )

  it.each(['worktree', 'folder'] as const)(
    'rejects the previous %s listing owner after host selection changes',
    (workspace) => {
      const state = makeState(workspace, 'host-b')
      expect(
        getFileExplorerWatchRuntimeEnvironmentId(state, state.activeWorktreeId, owner('host-a'))
      ).toBeUndefined()
      expect(
        getFileExplorerWatchRuntimeEnvironmentId(state, state.activeWorktreeId, owner('host-b'))
      ).toBe('host-b')
    }
  )

  it('does not apply the selected host to a different workspace', () => {
    const state = makeState('worktree', 'host-b')
    state.activeWorktreeId = 'different-worktree'
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(state, 'same-worktree', owner('host-b'))
    ).toBeUndefined()
  })
})
