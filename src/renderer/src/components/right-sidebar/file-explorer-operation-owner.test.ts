import { describe, expect, it } from 'vitest'
import {
  getFileExplorerOperationOwnerFromState,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import type { AppState } from '@/store/types'

type OwnerState = Parameters<typeof getFileExplorerOperationOwnerFromState>[0]

const REPO_ID = 'repo-cudnn'
const WORKTREE_ID = `${REPO_ID}::/home/tiger/workspace/cudnn`

// Minimal state where the worktree is stamped host:local (the headless-serve case).
function localWorktreeState(activeRuntimeEnvironmentId: string | null): OwnerState {
  return {
    settings: { activeRuntimeEnvironmentId } as AppState['settings'],
    repos: [
      {
        id: REPO_ID,
        path: '/home/tiger/workspace/cudnn',
        displayName: 'cudnn',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: null,
        connectionId: null
      }
    ] as AppState['repos'],
    worktreesByRepo: {
      [REPO_ID]: [{ id: WORKTREE_ID, repoId: REPO_ID, hostId: 'local' }]
    } as unknown as AppState['worktreesByRepo'],
    detectedWorktreesByRepo: {} as AppState['detectedWorktreesByRepo'],
    folderWorkspaces: [] as unknown as AppState['folderWorkspaces'],
    projectGroups: [] as unknown as AppState['projectGroups'],
    restoredRuntimeHostIdByWorkspaceSessionKey:
      {} as AppState['restoredRuntimeHostIdByWorkspaceSessionKey']
  }
}

describe('getFileExplorerOperationOwnerFromState — web client local worktrees', () => {
  it('desktop client keeps a local worktree as local', () => {
    const owner = getFileExplorerOperationOwnerFromState(
      localWorktreeState('web-abc'),
      WORKTREE_ID,
      false
    )
    expect(owner).toEqual({ kind: 'local' })
    expect(getFileExplorerOperationRoute(owner)).toEqual({
      settings: { activeRuntimeEnvironmentId: null },
      expectedExecutionHostId: 'local'
    })
  })

  it('web client routes a local worktree to the connected server runtime env', () => {
    const owner = getFileExplorerOperationOwnerFromState(
      localWorktreeState('web-abc'),
      WORKTREE_ID,
      true
    )
    expect(owner).toEqual({
      kind: 'runtime',
      environmentId: 'web-abc',
      executionHostId: 'runtime:web-abc'
    })
    expect(getFileExplorerOperationRoute(owner)).toEqual({
      settings: { activeRuntimeEnvironmentId: 'web-abc' },
      expectedExecutionHostId: 'local'
    })
  })

  it('web client with no connected runtime env falls back to local (unchanged)', () => {
    const owner = getFileExplorerOperationOwnerFromState(
      localWorktreeState(null),
      WORKTREE_ID,
      true
    )
    expect(owner).toEqual({ kind: 'local' })
  })
})
