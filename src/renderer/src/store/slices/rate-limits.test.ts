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

  // Why: `claude` is keyed by runtime target, not account (see
  // clearActiveClaudeRateLimits), so a stale snapshot from a previous
  // account must be cleared explicitly rather than assumed to expire.
  it('clears the active Claude snapshot without touching the rest of the state', () => {
    const store = createRateLimitStore()
    const codex = {
      provider: 'codex' as const,
      session: null,
      weekly: null,
      updatedAt: 456,
      error: null,
      status: 'ok' as const
    }
    store.setState({
      rateLimits: {
        ...store.getState().rateLimits,
        claude: {
          provider: 'claude',
          session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
          weekly: null,
          updatedAt: 123,
          error: null,
          status: 'ok'
        },
        codex
      }
    })

    store.getState().clearActiveClaudeRateLimits()

    expect(store.getState().rateLimits.claude).toBeNull()
    // Why: a broad reset (e.g. `{ rateLimits: createEmptyRateLimitState() }`)
    // would also wipe Codex and other providers; this only invalidates Claude.
    expect(store.getState().rateLimits.codex).toBe(codex)
  })
})
