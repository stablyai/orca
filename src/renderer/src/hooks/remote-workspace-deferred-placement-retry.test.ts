import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import { createDeferredSnapshotPlacementRetries } from './remote-workspace-deferred-placement-retry'
import type { RemoteWorkspaceSnapshotPlacementStore } from './remote-workspace-snapshot-placement'
import {
  appState,
  flush,
  owner,
  snapshot
} from './__tests__/remote-workspace-target-sync-test-harness'

/** `appState()` carries worktree `repo-a::/remote/work`, so this path is placeable at once. */
const PLACEABLE_PATH = '/remote/work'

function placementStore(): RemoteWorkspaceSnapshotPlacementStore {
  const state = appState()
  return { getState: () => state, subscribe: () => () => {} }
}

const rejections: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  rejections.push(reason)
}
process.on('unhandledRejection', onUnhandled)
afterEach(() => {
  rejections.length = 0
})

describe('createDeferredSnapshotPlacementRetries', () => {
  it('swallows a getSnapshot rejection instead of leaving it unhandled', async () => {
    const applySnapshot = vi.fn(async () => {})
    const retries = createDeferredSnapshotPlacementRetries({
      store: placementStore(),
      getCurrentAuthority: () => owner,
      getSnapshot: () => Promise.reject(new Error('relay dropped')),
      applySnapshot
    })

    retries.watch(owner, [PLACEABLE_PATH])
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rejections).toEqual([])
    // A failed pull is unverifiable, so the target is left on `conflict` rather than re-applied.
    expect(applySnapshot).not.toHaveBeenCalled()
    retries.stop()
  })

  it('swallows an applySnapshot rejection instead of leaving it unhandled', async () => {
    const retries = createDeferredSnapshotPlacementRetries({
      store: placementStore(),
      getCurrentAuthority: () => owner,
      getSnapshot: async () => snapshot(4),
      applySnapshot: () => Promise.reject(new Error('relay dropped'))
    })

    retries.watch(owner, [PLACEABLE_PATH])
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rejections).toEqual([])
    retries.stop()
  })

  it('bounds an apply that keeps re-arming the same unplaced paths', async () => {
    // Guards the test itself: without a bound the chain never yields and the run would hang.
    const CHAIN_GUARD = 50
    let pulls = 0
    const retries = createDeferredSnapshotPlacementRetries({
      store: placementStore(),
      getCurrentAuthority: () => owner,
      getSnapshot: async (): Promise<RemoteWorkspaceObservedSnapshot> => {
        pulls += 1
        return snapshot(4 + pulls)
      },
      applySnapshot: async () => {
        // The apply reports the same still-unplaced path, which arms the next watch.
        if (pulls < CHAIN_GUARD) {
          retries.watch(owner, [PLACEABLE_PATH])
        }
      }
    })

    retries.watch(owner, [PLACEABLE_PATH])
    for (let tick = 0; tick < CHAIN_GUARD * 2; tick += 1) {
      await flush()
    }

    expect(pulls).toBeLessThan(CHAIN_GUARD)
    expect(pulls).toBe(3)
    retries.stop()
  })

  it('lets a chain that keeps placing rows run past the stalled bound', async () => {
    // Five placeable paths, one fewer unplaced each round: that chain is converging and is already
    // bounded by the set emptying, so the stall bound must not cut it off at 3.
    const state = appState({
      worktreesByRepo: {
        'repo-a': [1, 2, 3, 4, 5].map((n) => ({
          id: `repo-a::/remote/w${n}`,
          repoId: 'repo-a',
          hostId: 'ssh:target-a'
        }))
      }
    })
    const allPaths = [1, 2, 3, 4, 5].map((n) => `/remote/w${n}`)
    let pulls = 0
    let remaining = allPaths.length
    const retries = createDeferredSnapshotPlacementRetries({
      store: { getState: () => state, subscribe: () => () => {} },
      getCurrentAuthority: () => owner,
      getSnapshot: async (): Promise<RemoteWorkspaceObservedSnapshot> => {
        pulls += 1
        return snapshot(4 + pulls)
      },
      applySnapshot: async () => {
        remaining -= 1
        retries.watch(owner, allPaths.slice(0, remaining))
      }
    })

    retries.watch(owner, allPaths)
    for (let tick = 0; tick < 40; tick += 1) {
      await flush()
    }

    // One pull per round until the unplaced set empties -- five, not the stall bound of three.
    expect(pulls).toBe(5)
    retries.stop()
  })

  it('does not spend the chain budget on watches armed outside a retry', async () => {
    let pulls = 0
    const retries = createDeferredSnapshotPlacementRetries({
      store: placementStore(),
      getCurrentAuthority: () => owner,
      getSnapshot: async (): Promise<RemoteWorkspaceObservedSnapshot> => {
        pulls += 1
        return snapshot(4 + pulls)
      },
      applySnapshot: async () => {}
    })

    // Each of these is a fresh host snapshot arrival, not a continued chain.
    for (let arrival = 0; arrival < 6; arrival += 1) {
      retries.watch(owner, [PLACEABLE_PATH])
      await flush()
      await flush()
    }

    expect(pulls).toBe(6)
    retries.stop()
  })
})
