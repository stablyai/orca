import { describe, expect, it } from 'vitest'
import { getProviderUsageStatusLabel } from './usage-error-copy'

const translate = (_key: string, fallback: string, options?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))

describe('getProviderUsageStatusLabel for a rate-limited usage check', () => {
  it('names the check and when it may retry instead of reading as exhausted quota', () => {
    const usage = {
      provider: 'claude',
      error: 'OAuth usage request was rate limited. Try again later.',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 12 * 60_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited, retry in 12m')
  })

  it('rounds a partial minute up so it never shows a zero-minute wait', () => {
    const usage = {
      provider: 'claude',
      error: 'rate limited',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 20_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited, retry in 1m')
  })

  it('drops a retry time that has already elapsed', () => {
    const usage = {
      provider: 'claude',
      error: 'rate limited',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() - 60_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited')
  })

  it('uses the plain check label when the reading carries no retry time', () => {
    const usage = { provider: 'claude', error: 'rate limited' }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited')
  })
})
