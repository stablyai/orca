import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createRateLimitSlice } from './rate-limits'
import type { AppState } from '../types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'

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

  it('initializes the Z.AI snapshot and auth flag as unconfigured', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.zai).toBeNull()
    expect(store.getState().rateLimits.zaiAuthConfigured).toBe(false)
  })

  it('keeps Z.AI defaults when an old host pushes a payload without the keys', () => {
    const store = createRateLimitStore()
    const oldHostPush = {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      minimaxCookieConfigured: false,
      grokAuthConfigured: true,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    } satisfies RateLimitState

    store.getState().setRateLimitsFromPush(oldHostPush)

    const rateLimits = store.getState().rateLimits
    expect(rateLimits.zai).toBeNull()
    expect(rateLimits.zaiAuthConfigured).toBe(false)
    expect(rateLimits.grokAuthConfigured).toBe(true)
  })

  it('preserves a new host Z.AI payload through the push path', () => {
    const store = createRateLimitStore()
    const zaiSnapshot = {
      provider: 'zai' as const,
      session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok' as const
    }

    store.getState().setRateLimitsFromPush({ zai: zaiSnapshot, zaiAuthConfigured: true } as never)

    const rateLimits = store.getState().rateLimits
    expect(rateLimits.zai).toMatchObject({ provider: 'zai', status: 'ok' })
    expect(rateLimits.zaiAuthConfigured).toBe(true)
  })
})
