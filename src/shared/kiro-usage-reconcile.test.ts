import { describe, expect, it } from 'vitest'
import { reconcileKiroProvider } from './kiro-usage-reconcile'
import type { ProviderRateLimits } from './rate-limit-types'

function kiro(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
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
    status: 'ok',
    ...overrides
  }
}

const erroredNoData = kiro({
  monthly: null,
  planType: null,
  kiroCredits: null,
  status: 'error',
  error: 'boom',
  updatedAt: 900
})
const unavailable = kiro({
  monthly: null,
  planType: null,
  kiroCredits: null,
  status: 'unavailable',
  error: null
})

describe('reconcileKiroProvider', () => {
  it('uses fresh limits when the fetch is ok', () => {
    const fresh = kiro({
      monthly: {
        usedPercent: 20,
        windowMinutes: 43200,
        resetsAt: 2000,
        resetDescription: '2026-10-01'
      }
    })
    expect(reconcileKiroProvider(kiro(), fresh)).toBe(fresh)
  })

  it('retains the last good monthly window on a transient error (stale)', () => {
    const previous = kiro()
    const result = reconcileKiroProvider(previous, erroredNoData)
    expect(result.status).toBe('error')
    expect(result.monthly).toEqual(previous.monthly)
    expect(result.planType).toBe('KIRO PRO')
    expect(result.kiroCredits).toEqual(previous.kiroCredits)
    expect(result.error).toBe('boom')
    // keeps the original timestamp so the UI can show how stale it is
    expect(result.updatedAt).toBe(previous.updatedAt)
  })

  it('surfaces the error when there is no prior data to keep', () => {
    const result = reconcileKiroProvider(null, erroredNoData)
    expect(result.status).toBe('error')
    expect(result.monthly).toBeNull()
  })

  it('clears to unavailable when the CLI is genuinely gone, even with prior data', () => {
    const result = reconcileKiroProvider(kiro(), unavailable)
    expect(result.status).toBe('unavailable')
    expect(result.monthly).toBeNull()
  })
})
