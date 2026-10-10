import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createWorktreeEventLineageRefresh } from './worktree-event-lineage-refresh'
import { createWorktreeEventRuntime } from './worktree-event-runtime'

const HOST_A = { executionHostId: 'runtime:host-a' } as const

function deferredFetches() {
  const pending: PromiseWithResolvers<void>[] = []
  const fetch = vi.fn(() => {
    const next = Promise.withResolvers<void>()
    pending.push(next)
    return next.promise
  })
  return { fetch, pending }
}

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createWorktreeEventLineageRefresh', () => {
  const listed = async () => {}

  it('waits for staggered listings on a host, then fetches lineage once', async () => {
    const fetch = vi.fn(async () => {})
    const refresh = createWorktreeEventLineageRefresh(fetch)
    const listings = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    const handlers = listings.map((listing) => refresh(HOST_A, () => listing.promise))

    for (const listing of listings) {
      listing.resolve()
      await nextMacrotask()
    }
    await Promise.all(handlers)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(HOST_A)
  })

  it('serves a caller that arrives during a fetch with the next fetch', async () => {
    const { fetch, pending } = deferredFetches()
    const refresh = createWorktreeEventLineageRefresh(fetch)

    const first = refresh(HOST_A, listed)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const late = Array.from({ length: 5 }, () => refresh(HOST_A, listed))
    let lateSettled = false
    void Promise.all(late).then(() => {
      lateSettled = true
    })

    pending[0].resolve()
    await first
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(lateSettled).toBe(false)
    pending[1].resolve()
    await Promise.all(late)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('releases waiting callers when another listing fails', async () => {
    const fetch = vi.fn(async () => {})
    const refresh = createWorktreeEventLineageRefresh(fetch)
    const failing = Promise.withResolvers<void>()
    const failed = refresh(HOST_A, () => failing.promise)
    const waiting = refresh(HOST_A, listed)
    await nextMacrotask()
    expect(fetch).not.toHaveBeenCalled()

    failing.reject(new Error('listing failed'))
    await expect(failed).rejects.toThrow('listing failed')
    await waiting
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps hosts and the forced-local target independent', async () => {
    const { fetch } = deferredFetches()
    const refresh = createWorktreeEventLineageRefresh(fetch)

    void refresh(HOST_A, listed)
    void refresh({ executionHostId: 'runtime:host-b' }, listed)
    void refresh({ forceLocalOwner: true }, listed)
    void refresh(undefined, listed)

    await vi.waitFor(() =>
      expect(fetch.mock.calls).toEqual([
        [HOST_A],
        [{ executionHostId: 'runtime:host-b' }],
        [{ forceLocalOwner: true }],
        [undefined]
      ])
    )
  })
})

describe('worktree change events', () => {
  const initialState = useAppStore.getState()
  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  it('fetches host lineage once for a burst whose listings land one by one', async () => {
    const listings: PromiseWithResolvers<boolean>[] = []
    const fetchWorktrees = vi.spyOn(initialState, 'fetchWorktrees').mockImplementation(() => {
      const listing = Promise.withResolvers<boolean>()
      listings.push(listing)
      return listing.promise
    })
    // Why instant: a lineage reply that settles before the next listing lands is the worst case.
    const fetchWorktreeLineage = vi
      .spyOn(initialState, 'fetchWorktreeLineage')
      .mockResolvedValue(undefined)
    useAppStore.setState({
      fetchWorktrees: initialState.fetchWorktrees,
      fetchWorktreeLineage: initialState.fetchWorktreeLineage
    })
    const unsubs: (() => void)[] = []
    const runtime = createWorktreeEventRuntime(unsubs, () => true)
    try {
      for (let index = 0; index < 25; index++) {
        runtime.worktreeChangeRefreshQueue.enqueue({
          repoId: `repo-${index}`,
          executionHostId: HOST_A.executionHostId
        })
      }
      await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalledTimes(25))
      for (const listing of listings) {
        listing.resolve(true)
        await nextMacrotask()
      }
      await vi.waitFor(() => expect(fetchWorktreeLineage).toHaveBeenCalledTimes(1))
      await nextMacrotask()
      expect(fetchWorktreeLineage).toHaveBeenCalledTimes(1)
      expect(fetchWorktreeLineage).toHaveBeenCalledWith(HOST_A)
    } finally {
      listings.forEach((listing) => listing.resolve(true))
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
  })
})
