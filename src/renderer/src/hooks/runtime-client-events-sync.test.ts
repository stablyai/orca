import { describe, it, expect, vi } from 'vitest'
import {
  createRuntimeClientEventsSync,
  type RuntimeClientEventSubscriptionHandle
} from './runtime-client-events-sync'

type SubscribeRecord = {
  environmentId: string
  resolveWith: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function makeHarness(initialDesired: string[]) {
  let desired = initialDesired
  const records: SubscribeRecord[] = []
  const subscribe = vi.fn(
    (environmentId: string): Promise<RuntimeClientEventSubscriptionHandle> => {
      const unsubscribe = vi.fn()
      let resolveFn!: (handle: RuntimeClientEventSubscriptionHandle) => void
      const promise = new Promise<RuntimeClientEventSubscriptionHandle>((resolve) => {
        resolveFn = resolve
      })
      records.push({ environmentId, resolveWith: () => resolveFn({ unsubscribe }), unsubscribe })
      return promise
    }
  )
  const sync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => desired,
    subscribe,
    onEvent: vi.fn()
  })
  return {
    sync,
    records,
    subscribe,
    setDesired: (next: string[]) => {
      desired = next
    },
    recordsFor: (environmentId: string) =>
      records.filter((record) => record.environmentId === environmentId)
  }
}

// Lets all pending subscribe `.then` microtasks settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createRuntimeClientEventsSync', () => {
  it('subscribes desired environments and unsubscribes ones that leave the set', async () => {
    const h = makeHarness(['A'])
    h.sync.sync()
    h.recordsFor('A')[0].resolveWith()
    await flush()

    h.setDesired([])
    h.sync.sync()

    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not leak an orphaned subscription when an env is toggled off then on mid-subscribe', async () => {
    // 'B' stays subscribed throughout so subscriptions is never empty — this is
    // what prevents the generation from bumping and exposes the overwrite race.
    const h = makeHarness(['B'])
    h.sync.sync()
    h.recordsFor('B')[0].resolveWith()
    await flush()

    // 'A' becomes desired — first subscribe starts (kept in flight).
    h.setDesired(['A', 'B'])
    h.sync.sync()

    // 'A' removed while its subscribe is in flight (generation does NOT bump
    // because 'B' keeps subscriptions non-empty).
    h.setDesired(['B'])
    h.sync.sync()

    // 'A' desired again before the first subscribe resolved — the de-dupe guard
    // sees no live subscription and no pending entry, so it subscribes AGAIN.
    h.setDesired(['A', 'B'])
    h.sync.sync()

    const aRecords = h.recordsFor('A')
    expect(aRecords).toHaveLength(2) // the duplicate subscribe really happened

    // Resolve both A subscribes.
    aRecords[0].resolveWith()
    await flush()
    aRecords[1].resolveWith()
    await flush()

    // Exactly one of the two duplicate subscriptions is unsubscribed (the loser);
    // the other is retained in the map. Before the fix the second resolution
    // overwrote the first's unsubscribe in the map, leaking it (0 unsubscribes).
    const aUnsubscribed = aRecords.filter(
      (record) => record.unsubscribe.mock.calls.length > 0
    ).length
    expect(aUnsubscribed).toBe(1)

    // 'B' is untouched.
    expect(h.recordsFor('B')[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('stop() unsubscribes everything and ignores in-flight resolutions', async () => {
    const h = makeHarness(['A'])
    h.sync.sync()
    h.recordsFor('A')[0].resolveWith()
    await flush()

    h.sync.stop()
    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)

    // A subscribe that resolves after stop() must not re-register; it unsubscribes.
    h.setDesired(['C'])
    h.sync.sync()
    h.sync.stop()
    h.recordsFor('C')[0].resolveWith()
    await flush()
    expect(h.recordsFor('C')[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('retries failed desired subscriptions without another store-driven sync', async () => {
    vi.useFakeTimers()
    try {
      let desired = ['A']
      let attempt = 0
      const unsubscribe = vi.fn()
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> => {
        attempt += 1
        if (attempt === 1) {
          return Promise.reject(new Error('temporary subscribe failure'))
        }
        return Promise.resolve({ unsubscribe })
      })
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => desired,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10
      })

      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(9)
      expect(subscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(2)

      desired = []
      sync.sync()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
