import type { ExecutionHostId } from '../../../../shared/execution-host'

export type WorktreeEventLineageTarget =
  | { forceLocalOwner: true }
  | { executionHostId: ExecutionHostId }
  | undefined

type HostLineageState = {
  target: WorktreeEventLineageTarget
  listingsInFlight: number
  nextBatch: PromiseWithResolvers<void> | null
  fetching: boolean
}

function lineageTargetKey(target: WorktreeEventLineageTarget): string {
  if (!target) {
    return 'active-target'
  }
  return 'forceLocalOwner' in target ? 'force-local' : `host:${target.executionHostId}`
}

/**
 * Lineage is host-wide while change events are per repo, so one host save that touches 25 repos
 * used to fetch the same lineage 25 times. A burst now shares one fetch, started once every
 * listing in flight on that host has landed; each caller's fetch still starts after its listing.
 */
export function createWorktreeEventLineageRefresh(
  fetchWorktreeLineage: (target: WorktreeEventLineageTarget) => Promise<void>
): <T>(target: WorktreeEventLineageTarget, listing: () => Promise<T>) => Promise<T> {
  const hosts = new Map<string, HostLineageState>()

  const startBatchWhenSettled = (key: string, state: HostLineageState): void => {
    if (state.fetching || state.listingsInFlight > 0) {
      return
    }
    const batch = state.nextBatch
    if (!batch) {
      hosts.delete(key)
      return
    }
    state.nextBatch = null
    state.fetching = true
    // Why the executor: a synchronous throw must reject the batch, not escape into a listing's release.
    void new Promise<void>((resolve) => resolve(fetchWorktreeLineage(state.target)))
      .then(batch.resolve, batch.reject)
      .finally(() => {
        state.fetching = false
        startBatchWhenSettled(key, state)
      })
  }

  const stateFor = (key: string, target: WorktreeEventLineageTarget): HostLineageState => {
    const existing = hosts.get(key)
    if (existing) {
      return existing
    }
    const created = { target, listingsInFlight: 0, nextBatch: null, fetching: false }
    hosts.set(key, created)
    return created
  }

  return async function refreshAfterListing<T>(
    target: WorktreeEventLineageTarget,
    listing: () => Promise<T>
  ): Promise<T> {
    const key = lineageTargetKey(target)
    const state = stateFor(key, target)
    state.listingsInFlight += 1
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        state.listingsInFlight -= 1
        startBatchWhenSettled(key, state)
      }
    }
    try {
      const result = await listing()
      // Why join before releasing the slot: the last listing must not start a fetch it then misses.
      state.nextBatch ??= Promise.withResolvers<void>()
      const { promise } = state.nextBatch
      release()
      await promise
      return result
    } finally {
      release()
    }
  }
}
