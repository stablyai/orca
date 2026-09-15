import { createStore } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const watchOwnedRateLimits = vi.fn()

type SubscriptionStoreState = {
  settings: { activeRuntimeEnvironmentId: string | null } | null
  runtimeEnvironments: { id: string; name: string }[]
  rateLimitUsageByHost: Record<string, { generation: number }>
  setRateLimitUsageOwner: (hostId: string) => void
  applyOwnedRateLimits: (update: unknown) => void
}

const setRateLimitUsageOwner = vi.fn()
const applyOwnedRateLimits = vi.fn()

const store = createStore<SubscriptionStoreState>()(() => ({
  settings: { activeRuntimeEnvironmentId: null },
  runtimeEnvironments: [{ id: 'env-b', name: 'Remote B' }],
  rateLimitUsageByHost: { 'runtime:env-b': { generation: 4 } },
  setRateLimitUsageOwner,
  applyOwnedRateLimits
}))

vi.mock('./runtime-usage-owner-client', () => ({
  watchOwnedRateLimits: (...args: unknown[]) => watchOwnedRateLimits(...args)
}))
vi.mock('../store', () => ({ useAppStore: store }))

const { subscribeRateLimitUsageOwner } = await import('./rate-limit-usage-owner-subscription')

function selectEnvironment(environmentId: string | null): void {
  store.setState({ settings: { activeRuntimeEnvironmentId: environmentId } })
}

beforeEach(() => {
  watchOwnedRateLimits.mockReset()
  setRateLimitUsageOwner.mockReset()
  applyOwnedRateLimits.mockReset()
  selectEnvironment(null)
})

describe('subscribeRateLimitUsageOwner', () => {
  it('opens no remote subscription while the local owner is selected', () => {
    const dispose = subscribeRateLimitUsageOwner()

    expect(watchOwnedRateLimits).not.toHaveBeenCalled()
    dispose()
  })

  it('follows a switch to a paired runtime and stamps its current generation', () => {
    watchOwnedRateLimits.mockReturnValue({ close: vi.fn() })
    const dispose = subscribeRateLimitUsageOwner()

    selectEnvironment('env-b')

    expect(setRateLimitUsageOwner).toHaveBeenCalledWith('runtime:env-b')
    expect(watchOwnedRateLimits).toHaveBeenCalledWith(
      'runtime:env-b',
      'Remote B',
      expect.any(Function)
    )
    const onReading = watchOwnedRateLimits.mock.calls[0][2] as (reading: unknown) => void
    onReading({ kind: 'usage' })
    expect(applyOwnedRateLimits).toHaveBeenCalledWith({
      hostId: 'runtime:env-b',
      generation: 4,
      reading: { kind: 'usage' }
    })
    dispose()
  })

  // Closing at the source is what stops a previous owner's in-flight snapshots
  // from ever reaching the store.
  it('closes the previous owner subscription before opening the next', () => {
    const closeB = vi.fn()
    watchOwnedRateLimits.mockReturnValueOnce({ close: closeB }).mockReturnValue({ close: vi.fn() })
    const dispose = subscribeRateLimitUsageOwner()

    selectEnvironment('env-b')
    expect(closeB).not.toHaveBeenCalled()

    selectEnvironment('env-c')
    expect(closeB).toHaveBeenCalledTimes(1)
    expect(watchOwnedRateLimits).toHaveBeenLastCalledWith(
      'runtime:env-c',
      // No saved name for this id; the host id's own label stands in.
      'env-c',
      expect.any(Function)
    )
    dispose()
  })

  it('closes the active subscription on dispose', () => {
    const close = vi.fn()
    watchOwnedRateLimits.mockReturnValue({ close })
    const dispose = subscribeRateLimitUsageOwner()
    selectEnvironment('env-b')

    dispose()

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not reopen the subscription for unrelated store updates', () => {
    watchOwnedRateLimits.mockReturnValue({ close: vi.fn() })
    const dispose = subscribeRateLimitUsageOwner()
    selectEnvironment('env-b')

    store.setState({ runtimeEnvironments: [{ id: 'env-b', name: 'Renamed' }] })

    expect(watchOwnedRateLimits).toHaveBeenCalledTimes(1)
    dispose()
  })
})
