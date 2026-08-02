import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createRateLimitSlice } from './rate-limits'
import type { AppState } from '../types'

function createRateLimitStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createRateLimitSlice(...(args as Parameters<typeof createRateLimitSlice>))
  ) as unknown as StoreApi<AppState>
}

describe('createRateLimitSlice', () => {
  it('initializes Antigravity usage with a stable pending key', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.antigravity).toBeNull()
  })
})
