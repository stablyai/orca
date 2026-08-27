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

  it('resolves a host-stamped SSH worktree when its project also exists locally (#10634)', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [
            { id: 'repo-1', executionHostId: 'local' },
            { id: 'repo-1', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
          ],
          worktreesByRepo: {
            'repo-1': [worktree('ssh:ssh-1')]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
    })
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

  it('fails a paired-client publication closed when no repo row can own it', () => {
    // Why: a worktree row on its own carries no host evidence. This is the fail-closed case
    // #9994 was defending — an owner that really is missing, not merely unstamped.
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [],
          runtimeEnvironments: [{ id: 'disconnected-hub' }],
          runtimeEnvironmentCatalogHydrated: true,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('fails ownerless rows closed mid-hydration while a saved runtime could own them', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
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

  // #16733: a genuinely local git worktree carries no host stamp on legacy rows. Every stamped
  // row is already routed by resolveExplicitWorktreeOperationRouteResult, so an unstamped repo
  // row reaching the legacy hydration gates is local by construction — the same positive-identity
  // argument the folder-workspace branch below already makes (#10251/#10269).
  describe('local git worktrees without a host stamp (#16733)', () => {
    const LOCAL_ROUTE = {
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    }

    it('keeps a local worktree local when an unrelated runtime is saved', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('keeps a local worktree local when several unrelated runtimes are saved', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'a' }, { id: 'b' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('routes a known local repo before its worktree row has been listed', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('keeps a local worktree local while the saved-runtime catalog is still hydrating', () => {
      // Why: the repo stamp is host evidence, not runtime-environment inference — an unhydrated
      // runtime catalog cannot turn an unstamped row into a remote one.
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: false,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('keeps a local worktree local after an unrelated runtime has been removed', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            removedRuntimeEnvironmentIds: new Set(['gone-hub']),
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('still routes a local worktree local when no runtime is saved', () => {
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
      ).toEqual(LOCAL_ROUTE)
    })

    it('still routes a local worktree local for adapters with no runtime catalog at all', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual(LOCAL_ROUTE)
    })

    it('never routes a connection-owned repo local when runtimes are saved', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1', connectionId: 'ssh-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
      })
    })

    it('never routes a runtime-stamped repo local when runtimes are saved', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1', executionHostId: 'runtime:hub-a' } as never],
            runtimeEnvironments: [{ id: 'hub-a' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('keeps a host-stamped worktree row authoritative over its unstamped repo', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree('ssh:ssh-1')] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
      })
    })

    it('fails a worktree closed when no repo row and no worktree row know it', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'other' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true
          },
          WORKTREE_ID
        )
      ).toEqual({ kind: 'missing' })
    })

    it('fails closed when the active runtime is ambiguous', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({ kind: 'missing' })
    })

    it('keeps an unambiguous active runtime authoritative over the local fallback', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
            repos: [{ id: 'repo-1' } as never],
            runtimeEnvironments: [{ id: 'hub-a' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('refuses local when a second repo row for the id is connection-owned', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [{ id: 'repo-1' } as never, { id: 'repo-1', connectionId: 'ssh-1' } as never],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
      })
    })

    it('reports contradictory repo rows as ambiguous rather than defaulting to local', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [
              { id: 'repo-1', executionHostId: 'local' } as never,
              { id: 'repo-1', executionHostId: 'runtime:hub-a' } as never
            ],
            runtimeEnvironments: [{ id: 'some-hub' }],
            runtimeEnvironmentCatalogHydrated: true,
            worktreesByRepo: { 'repo-1': [worktree(undefined)] }
          },
          WORKTREE_ID
        )
      ).toEqual({ kind: 'ambiguous' })
    })
  })

  describe('active workspace host selection', () => {
    it('keeps the HUB transport when the paired SSH worktree is the active workspace', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            activeWorktreeId: WORKTREE_ID,
            activeWorkspaceExecutionHostId: 'ssh:hub-private-target',
            worktreesByRepo: { 'repo-1': [worktree('ssh:hub-private-target', 'hub-a')] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:hub-private-target', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('recovers the HUB transport from the repo for an active mixed-version SSH publication', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            activeWorktreeId: WORKTREE_ID,
            activeWorkspaceExecutionHostId: 'ssh:hub-private-target',
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
        route: { executionHostId: 'ssh:hub-private-target', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('keeps the selected host authoritative when the same ID exists on two hosts', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            activeWorktreeId: WORKTREE_ID,
            activeWorkspaceExecutionHostId: 'runtime:hub-a',
            worktreesByRepo: { 'repo-1': [worktree('local'), worktree('runtime:hub-a')] }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
      })
    })

    it('drops the HUB transport when two HUBs project the active SSH worktree', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            activeWorktreeId: WORKTREE_ID,
            activeWorkspaceExecutionHostId: 'ssh:same-private-target',
            worktreesByRepo: {
              'repo-1': [
                worktree('ssh:same-private-target', 'hub-a'),
                worktree('ssh:same-private-target', 'hub-b')
              ]
            }
          },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:same-private-target', runtimeEnvironmentId: null }
      })
    })

    it('keeps an unknown active worktree on its selected host', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          { activeWorktreeId: WORKTREE_ID, activeWorkspaceExecutionHostId: 'ssh:ssh-1' },
          WORKTREE_ID
        )
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
      })
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

    it('routes a folder workspace and a git worktree alike in one local state (#16733)', () => {
      // Why: #10269 gave folder workspaces the positive-identity carve-out and left git worktrees
      // behind, so the same store answered `local` for one workspace kind and `missing` for the
      // other. Both kinds are locally owned here, so both must route locally.
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
