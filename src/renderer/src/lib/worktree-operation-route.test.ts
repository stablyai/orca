import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'

const WORKTREE_ID = 'repo-1::/srv/worktree'

function worktree(hostId: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/srv/worktree',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

describe('resolveWorktreeOperationRouteResult', () => {
  it('preserves SSH execution identity and its HUB transport owner', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          worktreesByRepo: {
            'repo-1': [worktree('ssh:hub-private-target', 'hub-a')]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: {
        executionHostId: 'ssh:hub-private-target',
        runtimeEnvironmentId: 'hub-a'
      }
    })
  })

  it('fails closed when the same SSH worktree is projected by two HUBs', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
          worktreesByRepo: {
            'repo-1': [
              worktree('ssh:same-private-target', 'hub-a'),
              worktree('ssh:same-private-target', 'hub-b')
            ]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'ambiguous' })
  })

  it('fails ownerless rows closed mid-hydration while a saved runtime could own them', () => {
    // No repo/active-runtime evidence can decide first: only the unhydrated saved-runtime catalog fails this closed. Marking it hydrated routes local via the detected row; adding other evidence would leave this branch uncovered.
    expect(
      resolveWorktreeOperationRouteResult(
        {
          runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
          runtimeEnvironmentCatalogHydrated: false,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  describe('folder workspaces', () => {
    const FOLDER_WORKSPACE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const FOLDER_KEY = `folder:${FOLDER_WORKSPACE_ID}`

    function folderWorkspace(connectionId: string | null = null) {
      return {
        id: FOLDER_WORKSPACE_ID,
        projectGroupId: 'group-1',
        folderPath: '/folder',
        connectionId
      }
    }

    it('routes a folder workspace and a git worktree alike in one local state (#16733)', () => {
      // Local folders and git worktrees must route alike; #10269 fixed only folders, leaving the same-state git case missing.
      const state = {
        repos: [{ id: 'repo-1' } as never],
        worktreesByRepo: { 'repo-1': [worktree(undefined)] },
        folderWorkspaces: [folderWorkspace()],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
        runtimeEnvironments: [{ id: 'some-hub' }],
        runtimeEnvironmentCatalogHydrated: true
      }
      const localRoute = {
        kind: 'resolved',
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
      }
      expect(resolveWorktreeOperationRouteResult(state, FOLDER_KEY)).toEqual(localRoute)
      expect(resolveWorktreeOperationRouteResult(state, WORKTREE_ID)).toEqual(localRoute)
    })
  })
})
