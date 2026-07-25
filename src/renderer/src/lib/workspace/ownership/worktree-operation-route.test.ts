import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
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

  it('prefers the focused HUB when the same SSH worktree is projected by two HUBs (#10491)', () => {
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
    ).toEqual({
      kind: 'resolved',
      route: {
        executionHostId: 'ssh:same-private-target',
        runtimeEnvironmentId: 'hub-a'
      }
    })
  })

  it('fails closed when two HUB projections share an id and focus matches neither', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
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

  it('prefers the local projection when local focus selects one of two host copies (#10491)', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          worktreesByRepo: {
            'repo-1': [worktree('local'), worktree('ssh:ssh-1', 'hub-a')]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('prefers the runtime projection when runtime focus selects one of two host copies (#10491)', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
          worktreesByRepo: {
            'repo-1': [worktree('local'), worktree('runtime:hub-a')]
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' }
    })
  })
})
