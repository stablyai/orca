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
  it('initializes every usage provider with a stable pending key', () => {
    const store = createRateLimitStore()
    const { rateLimits } = store.getState()

    // Why: the status bar reads these keys before the first poll; a missing key
    // reads as "provider not supported" rather than "snapshot not in yet".
    expect(rateLimits.claude).toBeNull()
    expect(rateLimits.codex).toBeNull()
    expect(rateLimits.opencodeGo).toBeNull()
    expect(rateLimits.kimi).toBeNull()
    expect(rateLimits.minimax).toBeNull()
    expect(rateLimits.grok).toBeNull()
  })
})
