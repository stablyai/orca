import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createRateLimitSlice } from './rate-limits'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

function createRateLimitStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createRateLimitSlice(...(args as Parameters<typeof createRateLimitSlice>))
  ) as unknown as StoreApi<AppState>
}

const kiroWithData: ProviderRateLimits = {
  provider: 'kiro',
  session: null,
  weekly: null,
  monthly: {
    usedPercent: 16,
    windowMinutes: 43200,
    resetsAt: 1000,
    resetDescription: '2026-10-01'
  },
  planType: 'KIRO PRO',
  kiroCredits: { used: 158, limit: 1000 },
  updatedAt: 500,
  error: null,
  status: 'ok'
}

describe('createRateLimitSlice', () => {
  it('initializes Antigravity usage with a stable pending key', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.antigravity).toBeNull()
  })

  // The main process owns Kiro's snapshot like any polled provider, so a push is
  // authoritative in both directions — no renderer-side merge to special-case.
  it('takes kiro from a host push', () => {
    const store = createRateLimitStore()
    store.getState().setRateLimitsFromPush(createEmptyRateLimitState({ kiro: kiroWithData }))
    expect(store.getState().rateLimits.kiro).toBe(kiroWithData)
  })

  it('clears kiro when the host reports it gone', () => {
    const store = createRateLimitStore()
    store.setState({ rateLimits: { ...store.getState().rateLimits, kiro: kiroWithData } })
    store.getState().setRateLimitsFromPush(createEmptyRateLimitState())
    expect(store.getState().rateLimits.kiro).toBeNull()
  })
})
