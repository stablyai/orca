import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

const LOCAL = 'local'
const HOST_A = 'runtime:env-a'
const HOST_B = 'runtime:env-b'

const readOwnedRateLimits = vi.fn()
const refreshOwnedRateLimits = vi.fn()

vi.mock('../../runtime/runtime-usage-owner-client', () => ({
  readOwnedRateLimits: (...args: unknown[]) => readOwnedRateLimits(...args),
  refreshOwnedRateLimits: (...args: unknown[]) => refreshOwnedRateLimits(...args)
}))

const { createRateLimitSlice } = await import('./rate-limits')

function claudeUsage(usedPercent: number, accountId: string): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    usageMetadata: { credentialSource: accountId }
  }
}

function usageState(usedPercent: number, accountId: string): RateLimitState {
  return createEmptyRateLimitState({ claude: claudeUsage(usedPercent, accountId) })
}

function usageReading(usedPercent: number, accountId: string) {
  return {
    kind: 'usage' as const,
    state: usageState(usedPercent, accountId),
    claudeAccountId: accountId,
    codexAccountId: null
  }
}

function createHarness(activeRuntimeEnvironmentId: string | null = null): StoreApi<AppState> {
  return createStore<AppState>()((...args) => {
    const [set, get] = args as Parameters<typeof createRateLimitSlice>
    return {
      settings: { activeRuntimeEnvironmentId },
      runtimeEnvironments: [
        { id: 'env-a', name: 'Remote A' },
        { id: 'env-b', name: 'Remote B' }
      ],
      ...createRateLimitSlice(set, get, {} as never)
    } as unknown as AppState
  })
}

function selectOwner(store: StoreApi<AppState>, environmentId: string | null): void {
  store.setState({
    settings: { activeRuntimeEnvironmentId: environmentId }
  } as unknown as Partial<AppState>)
  store.getState().setRateLimitUsageOwner(environmentId ? `runtime:${environmentId}` : LOCAL)
}

beforeEach(() => {
  readOwnedRateLimits.mockReset()
  refreshOwnedRateLimits.mockReset()
})

describe('rate-limit usage ownership routing', () => {
  it('routes the initial fetch through the selected owner, not the desktop', async () => {
    const store = createHarness('env-b')
    readOwnedRateLimits.mockResolvedValue(usageReading(71, 'account-b'))

    await store.getState().fetchRateLimits()

    expect(readOwnedRateLimits).toHaveBeenCalledWith(HOST_B, 'Remote B')
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(71)
    expect(store.getState().rateLimitUsageHostId).toBe(HOST_B)
  })

  it('routes a manual refresh through the selected owner', async () => {
    const store = createHarness('env-b')
    refreshOwnedRateLimits.mockResolvedValue(usageReading(42, 'account-b'))

    await store.getState().refreshRateLimits()

    expect(refreshOwnedRateLimits).toHaveBeenCalledWith(HOST_B, 'Remote B')
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(42)
  })

  // #16466: account B's usage on a remote host must not be replaced by the
  // desktop's own system account A.
  it('keeps a local push out of the displayed usage while a remote owner is selected', () => {
    const store = createHarness('env-b')
    store.getState().applyOwnedRateLimits({
      hostId: HOST_B,
      reading: usageReading(71, 'account-b')
    })

    store.getState().setRateLimitsFromPush(usageState(3, 'local-account-a'))

    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(71)
    expect(store.getState().rateLimits.claude?.usageMetadata?.credentialSource).toBe('account-b')
    // The desktop's own usage is still recorded — against the local owner.
    expect(store.getState().rateLimitUsageByHost[LOCAL]?.state.claude?.session?.usedPercent).toBe(3)
  })

  it('applies a local push to the display when the local owner is selected', () => {
    const store = createHarness(null)

    store.getState().setRateLimitsFromPush(usageState(3, 'local-account-a'))

    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(3)
  })

  // #15798: the status bar must follow the selected runtime on an owner switch.
  it('swaps the projection to the newly selected owner and back without refetching', () => {
    const store = createHarness('env-a')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_A, reading: usageReading(10, 'account-a') })

    selectOwner(store, 'env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(90, 'account-b') })
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(90)

    selectOwner(store, 'env-a')
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(10)
    expect(store.getState().rateLimits.claude?.usageMetadata?.credentialSource).toBe('account-a')
  })

  it('drops a delayed reply from the previous owner instead of overwriting the new one', () => {
    const store = createHarness('env-a')
    const staleGeneration = store.getState().rateLimitUsageByHost[HOST_A]?.generation ?? 0

    selectOwner(store, 'env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(90, 'account-b') })

    // Host A's read finally answers, long after the user moved to host B.
    store.getState().applyOwnedRateLimits({
      hostId: HOST_A,
      generation: staleGeneration,
      reading: usageReading(10, 'account-a')
    })

    expect(store.getState().rateLimitUsageHostId).toBe(HOST_B)
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(90)
    expect(store.getState().rateLimits.claude?.usageMetadata?.credentialSource).toBe('account-b')
  })

  it('drops a reply from a superseded activation of the SAME owner (A → B → A)', () => {
    const store = createHarness('env-a')
    const firstVisitGeneration = store.getState().rateLimitUsageByHost[HOST_A]?.generation ?? 0

    selectOwner(store, 'env-b')
    selectOwner(store, 'env-a')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_A, reading: usageReading(55, 'account-a') })

    // The first visit's read answers now; it is older than what A already shows.
    store.getState().applyOwnedRateLimits({
      hostId: HOST_A,
      generation: firstVisitGeneration,
      reading: usageReading(10, 'account-a')
    })

    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(55)
  })

  it('shows an explicit unavailable state for a host that does not report usage', async () => {
    const store = createHarness('env-b')
    readOwnedRateLimits.mockResolvedValue({
      kind: 'unavailable',
      unavailable: {
        reason: 'unsupported-host',
        message: 'Remote B does not report provider usage.'
      }
    })

    await store.getState().fetchRateLimits()

    expect(store.getState().rateLimitUsageUnavailable).toEqual({
      reason: 'unsupported-host',
      message: 'Remote B does not report provider usage.'
    })
    // Explicitly unavailable — never the desktop's numbers, and never a bar
    // that spins forever because the local settings say Claude is configured.
    expect(store.getState().rateLimits.claude?.status).toBe('unavailable')
    expect(store.getState().rateLimits.claude?.session).toBeNull()
  })

  it('does not let an unreachable owner fall back to local usage', async () => {
    const store = createHarness('env-b')
    store.getState().setRateLimitsFromPush(usageState(3, 'local-account-a'))
    refreshOwnedRateLimits.mockResolvedValue({
      kind: 'unavailable',
      unavailable: { reason: 'unreachable-host', message: 'Could not read provider usage.' }
    })

    await store.getState().refreshRateLimits()

    expect(store.getState().rateLimitUsageUnavailable?.reason).toBe('unreachable-host')
    expect(store.getState().rateLimits.claude?.session).toBeNull()
  })

  it('keeps the same account id on two different hosts distinct', () => {
    const store = createHarness('env-a')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_A, reading: usageReading(10, 'shared-id') })
    selectOwner(store, 'env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(90, 'shared-id') })

    expect(store.getState().rateLimitUsageByHost[HOST_A]?.state.claude?.session?.usedPercent).toBe(
      10
    )
    expect(store.getState().rateLimitUsageByHost[HOST_B]?.state.claude?.session?.usedPercent).toBe(
      90
    )
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(90)
  })

  it('keeps the last remote reading on screen when contact with the owner is lost', () => {
    const store = createHarness('env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(71, 'account-b') })

    store.getState().applyOwnedRateLimits({
      hostId: HOST_B,
      reading: { kind: 'contact-lost', message: 'Lost contact with Remote B.' }
    })

    // Lost contact is `unverifiable`: the numbers stand, and the UI says they
    // are no longer being confirmed.
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(71)
    expect(store.getState().rateLimitUsageContactLost?.message).toBe('Lost contact with Remote B.')
    expect(store.getState().rateLimitUsageUnavailable).toBeNull()
  })

  it('clears the lost-contact marker when the owner answers again', () => {
    const store = createHarness('env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(71, 'account-b') })
    store.getState().applyOwnedRateLimits({
      hostId: HOST_B,
      reading: { kind: 'contact-lost', message: 'Lost contact with Remote B.' }
    })

    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(88, 'account-b') })

    expect(store.getState().rateLimitUsageContactLost).toBeNull()
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(88)
  })

  it('carries the lost-contact marker across an owner switch away and back', () => {
    const store = createHarness('env-b')
    store
      .getState()
      .applyOwnedRateLimits({ hostId: HOST_B, reading: usageReading(71, 'account-b') })
    store.getState().applyOwnedRateLimits({
      hostId: HOST_B,
      reading: { kind: 'contact-lost', message: 'Lost contact with Remote B.' }
    })

    selectOwner(store, null)
    expect(store.getState().rateLimitUsageContactLost).toBeNull()

    selectOwner(store, 'env-b')
    expect(store.getState().rateLimitUsageContactLost?.message).toBe('Lost contact with Remote B.')
    expect(store.getState().rateLimits.claude?.session?.usedPercent).toBe(71)
  })

  it('refuses a Codex reset credit against a remote owner', async () => {
    const store = createHarness('env-b')

    await expect(store.getState().consumeCodexRateLimitResetCredit()).rejects.toThrow(
      'only available for local accounts'
    )
  })
})
