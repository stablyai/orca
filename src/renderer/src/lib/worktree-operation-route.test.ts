import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/types'
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

  it('recovers the HUB owner from its repo for a mixed-version SSH publication', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [
            {
              id: 'repo-1',
              connectionId: 'hub-private-target',
              executionHostId: 'runtime:hub-a'
            }
          ],
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree('ssh:hub-private-target')] }
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

  it('deduplicates identical projections from the same HUB', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          worktreesByRepo: {
            'repo-1': [
              worktree('ssh:same-private-target', 'hub-a'),
              worktree('ssh:same-private-target', 'hub-a')
            ]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: {
        executionHostId: 'ssh:same-private-target',
        runtimeEnvironmentId: 'hub-a'
      }
    })
  })

  it('uses the focused runtime only for legacy publications with no owner evidence', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'legacy-hub' } as never,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: {
        executionHostId: 'runtime:legacy-hub',
        runtimeEnvironmentId: 'legacy-hub'
      }
    })
  })

  it('fails a legacy publication closed when more than one runtime could own it', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
          runtimeEnvironments: [{ id: 'hub-a' } as never, { id: 'hub-b' } as never],
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('fails an unknown stale worktree closed instead of routing it locally', () => {
    expect(resolveWorktreeOperationRouteResult({}, WORKTREE_ID)).toEqual({ kind: 'missing' })
  })

  it('fails a paired-client ownerless stale publication closed instead of routing it locally', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'disconnected-hub' }],
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('fails ownerless rows closed until the saved-runtime catalog is hydrated', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: false,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('does not treat runtime focus as ownership while the saved-runtime catalog is loading', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: false,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('preserves ownerless local compatibility after an empty catalog hydrates', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: true,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('fails an unknown stale worktree closed instead of routing it through focus', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
          runtimeEnvironments: [{ id: 'hub-a' } as never]
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('does not let legacy runtime focus override explicit local ownership', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-hub' } as never,
          worktreesByRepo: { 'repo-1': [worktree('local')] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  describe('folder workspaces', () => {
    const FOLDER_WORKSPACE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const FOLDER_KEY = `folder:${FOLDER_WORKSPACE_ID}`

    function folderWorkspace(connectionId: string | null = null) {
      return { id: FOLDER_WORKSPACE_ID, projectGroupId: 'group-1', connectionId }
    }

    it('routes a local folder workspace to the local runtime (#10251)', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            folderWorkspaces: [folderWorkspace()],
            projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
            runtimeEnvironments: [],
            runtimeEnvironmentCatalogHydrated: true
          },
          FOLDER_KEY
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
      })
    })

    it('preserves SSH ownership for a connected folder workspace', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          { folderWorkspaces: [folderWorkspace('ssh-target-1')] },
          FOLDER_KEY
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:ssh-target-1', runtimeEnvironmentId: null }
      })
    })

    it('routes a runtime-owned project group folder workspace to its runtime', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            folderWorkspaces: [folderWorkspace()],
            projectGroups: [
              { id: 'group-1', connectionId: null, executionHostId: 'runtime:hub-a' } as never
            ]
          },
          FOLDER_KEY
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('scopes an ownerless folder workspace to the single focused runtime', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
            runtimeEnvironments: [{ id: 'hub-a' }],
            folderWorkspaces: [folderWorkspace()]
          },
          FOLDER_KEY
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('keeps a local folder workspace local when unrelated runtimes exist (#10251)', () => {
      const state = {
        folderWorkspaces: [folderWorkspace()],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
        settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
        runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
        runtimeEnvironmentCatalogHydrated: true
      }
      expect(resolveWorktreeOperationRouteResult(state, FOLDER_KEY)).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
      })
      // Why: the folder record is positive identity evidence, so it routes where an unknown
      // worktree in the same multi-runtime state still fails closed.
      expect(resolveWorktreeOperationRouteResult(state, 'repo-x::/tmp/unknown')).toEqual({
        kind: 'missing'
      })
    })

    it('routes a folder workspace to its restored runtime host during catalog hydration', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            folderWorkspaces: [folderWorkspace()],
            restoredRuntimeHostIdByWorkspaceSessionKey: { [FOLDER_KEY]: 'runtime:hub-a' }
          },
          FOLDER_KEY
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('fails an unknown folder workspace id closed', () => {
      expect(resolveWorktreeOperationRouteResult({}, FOLDER_KEY)).toEqual({ kind: 'missing' })
    })
  })
})
