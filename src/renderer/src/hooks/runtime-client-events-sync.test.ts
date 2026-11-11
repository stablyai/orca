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

  it('rekeys only the environment whose transport generation changed', async () => {
    const keys = new Map([
      ['A', 'A:1'],
      ['B', 'B:1']
    ])
    const records: SubscribeRecord[] = []
    const subscribe = vi.fn((environmentId: string) => {
      const unsubscribe = vi.fn()
      let resolveFn!: (handle: RuntimeClientEventSubscriptionHandle) => void
      const promise = new Promise<RuntimeClientEventSubscriptionHandle>((resolve) => {
        resolveFn = resolve
      })
      records.push({ environmentId, resolveWith: () => resolveFn({ unsubscribe }), unsubscribe })
      return promise
    })
    const sync = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => ['A', 'B'],
      getSubscriptionKey: (environmentId) => keys.get(environmentId) ?? environmentId,
      subscribe,
      onEvent: vi.fn()
    })

    sync.sync()
    records.forEach((record) => record.resolveWith())
    await flush()

    keys.set('A', 'A:2')
    sync.sync()

    const aRecords = records.filter((record) => record.environmentId === 'A')
    const bRecords = records.filter((record) => record.environmentId === 'B')
    expect(aRecords).toHaveLength(2)
    expect(aRecords[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(bRecords).toHaveLength(1)
    expect(bRecords[0].unsubscribe).not.toHaveBeenCalled()

    aRecords[1].resolveWith()
    await flush()
    expect(aRecords[1].unsubscribe).not.toHaveBeenCalled()
  })

  it('discards an in-flight subscription after its transport generation changes', async () => {
    let subscriptionKey = 'A:1'
    const h = makeHarness(['A'])
    const sync = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => ['A'],
      getSubscriptionKey: () => subscriptionKey,
      subscribe: h.subscribe,
      onEvent: vi.fn()
    })

    sync.sync()
    subscriptionKey = 'A:2'
    sync.sync()

    expect(h.recordsFor('A')).toHaveLength(2)
    h.recordsFor('A')[0].resolveWith()
    h.recordsFor('A')[1].resolveWith()
    await flush()

    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.recordsFor('A')[1].unsubscribe).not.toHaveBeenCalled()
  })

  it('does not leak an orphaned subscription when an env is toggled off then on mid-subscribe', async () => {
    // Keep B subscribed so generation never bumps, exposing duplicate A subscriptions across remove/re-add.
    const h = makeHarness(['B'])
    h.sync.sync()
    h.recordsFor('B')[0].resolveWith()
    await flush()

    h.setDesired(['A', 'B'])
    h.sync.sync()

    h.setDesired(['B'])
    h.sync.sync()

    h.setDesired(['A', 'B'])
    h.sync.sync()

    const aRecords = h.recordsFor('A')
    expect(aRecords).toHaveLength(2)

    aRecords[0].resolveWith()
    await flush()
    aRecords[1].resolveWith()
    await flush()

    // Retain the winning subscribe and unsubscribe the loser; overwriting formerly leaked its preload handle.
    const aUnsubscribed = aRecords.filter(
      (record) => record.unsubscribe.mock.calls.length > 0
    ).length
    expect(aUnsubscribed).toBe(1)

    expect(h.recordsFor('B')[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('stop() unsubscribes everything and ignores in-flight resolutions', async () => {
    const h = makeHarness(['A'])
    h.sync.sync()
    h.recordsFor('A')[0].resolveWith()
    await flush()

    h.sync.stop()
    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)

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
        retryDelayMs: 10,
        random: () => 1
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

  it('resubscribes on its own when the stream closes, backing off until a stream stays up', async () => {
    vi.useFakeTimers()
    try {
      const closes: (() => void)[] = []
      const unsubscribes: ReturnType<typeof vi.fn>[] = []
      const subscribe = vi.fn(
        (
          _environmentId: string,
          _onEvent: unknown,
          _onError: unknown,
          _isCurrent: unknown,
          onClose?: () => void
        ): Promise<RuntimeClientEventSubscriptionHandle> => {
          const unsubscribe = vi.fn()
          unsubscribes.push(unsubscribe)
          closes.push(() => onClose?.())
          // The first stream closes before its setup settles.
          if (closes.length === 1) {
            onClose?.()
          }
          return Promise.resolve({ unsubscribe })
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        getSubscriptionKey: () => 'A:1',
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        retryMaxDelayMs: 40,
        random: () => 1
      })

      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(2)

      // Streams that close right after setup back off 20, 40, then stay capped at 40.
      for (const [attempt, delay] of [
        [2, 20],
        [3, 40],
        [4, 40]
      ]) {
        closes[attempt - 1]()
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(subscribe).toHaveBeenCalledTimes(attempt)
        await vi.advanceTimersByTimeAsync(1)
        expect(subscribe).toHaveBeenCalledTimes(attempt + 1)
      }

      // A late close from a replaced stream must not drop the live one.
      closes[1]()
      await vi.advanceTimersByTimeAsync(40)
      expect(subscribe).toHaveBeenCalledTimes(5)

      // A stream that stayed up 30s ends the streak: the next retry uses the base delay.
      await vi.advanceTimersByTimeAsync(30_000)
      closes[4]()
      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off exponentially with a cap while an environment keeps failing', async () => {
    vi.useFakeTimers()
    try {
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> =>
        Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        retryMaxDelayMs: 40,
        random: () => 1
      })

      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(19)
      expect(subscribe).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(40)
      expect(subscribe).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(39)
      expect(subscribe).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh backoff epoch after the transport generation changes', async () => {
    vi.useFakeTimers()
    try {
      let subscriptionKey = 'A:1'
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> =>
        Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        getSubscriptionKey: () => subscriptionKey,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(2)

      subscriptionKey = 'A:2'
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribe).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(9)
      expect(subscribe).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an explicit recovery wake retries a waiting environment immediately', async () => {
    vi.useFakeTimers()
    try {
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> =>
        Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10_000,
        random: () => 1
      })

      sync.sync()
      // Settle rejection before external sync so a pending retry timer exists to bypass.
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribe).toHaveBeenCalledTimes(1)

      // Reachability changes retry immediately instead of waiting on backoff.
      sync.sync(['A'])
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([10, 100])('keeps retries local to due hosts in a fleet of %i', async (hostCount) => {
    vi.useFakeTimers()
    try {
      const desired = Array.from({ length: hostCount }, (_, i) => `host-${i}`)
      const getDesiredEnvironmentIds = vi.fn(() => desired)
      const getSubscriptionKey = vi.fn((id: string) => id)
      const closes = new Map<string, () => void>()
      const subscribe = vi.fn(
        (id: string, _event: unknown, _error: unknown, _current: unknown, close: () => void) => {
          closes.set(id, close)
          return Promise.resolve({ unsubscribe: vi.fn() })
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds,
        getSubscriptionKey,
        subscribe,
        onEvent: vi.fn(),
        random: () => 1
      })
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      getDesiredEnvironmentIds.mockClear()
      getSubscriptionKey.mockClear()
      subscribe.mockClear()

      closes.get('host-0')!()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(subscribe.mock.calls.map(([id]) => id)).toEqual(['host-0'])
      expect(getDesiredEnvironmentIds).not.toHaveBeenCalled()
      expect(getSubscriptionKey).not.toHaveBeenCalled()

      subscribe.mockClear()
      for (const close of closes.values()) {
        close()
      }
      // Every host is due once within 2s; only host-0 has a prior failure.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(subscribe).toHaveBeenCalledTimes(hostCount)
      expect(new Set(subscribe.mock.calls.map(([id]) => id)).size).toBe(hostCount)
      expect(getDesiredEnvironmentIds).not.toHaveBeenCalled()
      expect(getSubscriptionKey).not.toHaveBeenCalled()
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves sibling deadlines across retries, reconciliation, and scoped recovery', async () => {
    vi.useFakeTimers()
    try {
      const closes = new Map<string, () => void>()
      const attempts: { id: string; at: number }[] = []
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A', 'B'],
        subscribe: (id, _event, _error, _current, close) => {
          attempts.push({ id, at: Date.now() })
          closes.set(id, close)
          return Promise.resolve({ unsubscribe: vi.fn() })
        },
        onEvent: vi.fn(),
        random: () => 1
      })
      vi.setSystemTime(0)
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        closes.get('A')!()
        await vi.advanceTimersByTimeAsync(delay)
      }
      // A is due at 61s. B's first close at 31s must not reset A's deadline.
      closes.get('A')!()
      closes.get('B')!()
      sync.sync()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attempts.filter(({ id }) => id === 'A').map(({ at }) => at)).toEqual([
        0, 1_000, 3_000, 7_000, 15_000, 31_000
      ])
      expect(attempts.filter(({ id }) => id === 'B').map(({ at }) => at)).toEqual([0, 32_000])

      closes.get('B')!()
      sync.sync(['B'])
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts.filter(({ id }) => id === 'B').map(({ at }) => at)).toEqual([
        0, 32_000, 32_000
      ])
      await vi.advanceTimersByTimeAsync(28_999)
      expect(attempts.filter(({ id }) => id === 'A')).toHaveLength(6)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts.filter(({ id }) => id === 'A').map(({ at }) => at)).toEqual([
        0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000
      ])
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not carry a stale failure count when a rejection lands after the env left the set', async () => {
    vi.useFakeTimers()
    try {
      // Keep B pending so generation survives A leaving during subscribe and its late rejection reaches the same generation.
      let desired = ['A', 'B']
      const aRejecters: ((error: Error) => void)[] = []
      let aAttempts = 0
      const subscribe = vi.fn(
        (environmentId: string): Promise<RuntimeClientEventSubscriptionHandle> => {
          if (environmentId === 'B') {
            return new Promise(() => {})
          }
          aAttempts += 1
          return new Promise((_resolve, reject) => {
            aRejecters.push(reject)
          })
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => desired,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      sync.sync()
      expect(aAttempts).toBe(1)

      desired = ['B']
      sync.sync()

      aRejecters[0](new Error('unreachable'))
      await vi.advanceTimersByTimeAsync(0)

      desired = ['A', 'B']
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(aAttempts).toBe(2)
      aRejecters[1](new Error('unreachable'))
      await vi.advanceTimersByTimeAsync(0)

      // Discard out-of-scope failures or re-entry incorrectly starts with doubled backoff.
      await vi.advanceTimersByTimeAsync(9)
      expect(aAttempts).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(aAttempts).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
