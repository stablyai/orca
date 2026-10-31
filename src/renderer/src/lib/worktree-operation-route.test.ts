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

  it('routes an unstamped row local, never to the focused runtime', () => {
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
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
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

  it('routes the reported unstamped local shape with one saved runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'saved-runtime' }],
          runtimeEnvironmentCatalogHydrated: true,
          settings: { activeRuntimeEnvironmentId: null } as never,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('ignores the number of unrelated saved runtimes for unstamped local identity', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'runtime-a' }, { id: 'runtime-b' }, { id: 'runtime-c' }],
          runtimeEnvironmentCatalogHydrated: true,
          settings: { activeRuntimeEnvironmentId: null } as never,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('does not treat a repo row alone as positive local identity', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'saved-runtime' }],
          runtimeEnvironmentCatalogHydrated: true
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('fails a paired-client ownerless stale publication closed instead of routing it locally', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          runtimeEnvironments: [{ id: 'saved-runtime' }],
          runtimeEnvironmentCatalogHydrated: true
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('keeps an unstamped row ambiguous when another owner names a different host', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'saved-runtime' }],
          runtimeEnvironmentCatalogHydrated: true,
          worktreesByRepo: {
            'repo-1': [worktree('local'), worktree('runtime:hub-a')]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'ambiguous' })
  })

  it('never routes an unstamped row to the single saved, focused runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
          runtimeEnvironments: [{ id: 'hub-a' }],
          runtimeEnvironmentCatalogHydrated: true,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })

  it('ignores unrelated removed-runtime tombstones for positive local identity', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [{ id: 'saved-runtime' }],
          runtimeEnvironmentCatalogHydrated: true,
          removedRuntimeEnvironmentIds: new Set(['removed-runtime']),
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
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

  it('keeps an unstamped row local while the saved-runtime catalog is loading, focus or not', () => {
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
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('preserves ownerless local compatibility after an empty catalog hydrates', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          repos: [{ id: 'repo-1' } as never],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: true,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('preserves ownerless local compatibility before detected scan with no saved runtimes', () => {
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

  // Unstamped legacy repo rows prove local host ownership (#16733), matching the folder carve-out (#10251/#10269). They do not prove worktree identity: require a listed/detected worktree too (#16841).
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

    it('keeps a local worktree local while the saved-runtime catalog is still hydrating', () => {
      // Repo stamps prove host ownership; an unhydrated runtime catalog cannot turn unstamped local rows remote.
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

    it('keeps an unstamped row local whichever of several runtimes is focused', () => {
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
      ).toEqual({
        kind: 'resolved',
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
      })
    })

    it('keeps an unstamped row local when the single saved runtime is focused', () => {
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
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
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

    it('routes an unstamped row of a project shared with a paired server here (#25467)', () => {
      // Listings stamp every paired-server row, so the unstamped row was listed on this machine.
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [
              { id: 'repo-1', executionHostId: 'local' },
              { id: 'repo-1', executionHostId: 'runtime:hub-a' }
            ],
            runtimeEnvironments: [{ id: 'some-hub' }],
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

    it('reports contradictory paired-server repo rows as ambiguous rather than defaulting to local', () => {
      expect(
        resolveWorktreeOperationRouteResult(
          {
            repos: [
              { id: 'repo-1', executionHostId: 'runtime:hub-b' },
              { id: 'repo-1', executionHostId: 'runtime:hub-a' }
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

    // A transport-less route would go over this app's own SSH connection (review-5 #2).
    it('refuses when two HUBs project the active SSH worktree', () => {
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
      ).toEqual({ kind: 'ambiguous' })
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
      return {
        id: FOLDER_WORKSPACE_ID,
        projectGroupId: 'group-1',
        folderPath: '/folder',
        connectionId
      }
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

    it('keeps an ownerless folder workspace local when the single saved runtime is focused', () => {
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
        route: { executionHostId: 'local', runtimeEnvironmentId: null }
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
      // Folder records prove identity, so route where unknown worktrees in the same multi-runtime state fail closed.
      expect(resolveWorktreeOperationRouteResult(state, 'repo-x::/tmp/unknown')).toEqual({
        kind: 'missing'
      })
    })

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
