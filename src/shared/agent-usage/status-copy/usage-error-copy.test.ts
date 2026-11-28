import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProviderUsageStatusLabel, hasPendingUsageRetry } from './usage-error-copy'

const NOW = Date.parse('2026-11-24T12:00:00Z')

const translate = (_key: string, fallback: string, options?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))

describe('getProviderUsageStatusLabel for a rate-limited usage check', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the check and when it may retry instead of reading as exhausted quota', () => {
    const usage = {
      provider: 'claude',
      error: 'OAuth usage request was rate limited. Try again later.',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW + 12 * 60_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited, retry in 12m')
  })

  it('rounds a partial minute up so it never shows a zero-minute wait', () => {
    const usage = {
      provider: 'claude',
      error: 'rate limited',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW + 20_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited, retry in 1m')
  })

  it('drops a retry time that has already elapsed', () => {
    const usage = {
      provider: 'claude',
      error: 'rate limited',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW - 60_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited')
  })

  it('uses the plain check label when the reading carries no retry time', () => {
    const usage = { provider: 'claude', error: 'rate limited' }
    expect(getProviderUsageStatusLabel(usage, translate)).toBe('Usage check limited')
  })

  it('recounts the wait against the clock the caller renders on', () => {
    const usage = {
      provider: 'claude',
      error: 'rate limited',
      usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW + 12 * 60_000 }
    }
    expect(getProviderUsageStatusLabel(usage, translate, NOW)).toBe(
      'Usage check limited, retry in 12m'
    )
    expect(getProviderUsageStatusLabel(usage, translate, NOW + 10 * 60_000)).toBe(
      'Usage check limited, retry in 2m'
    )
    expect(getProviderUsageStatusLabel(usage, translate, NOW + 13 * 60_000)).toBe(
      'Usage check limited'
    )
  })

  it('flags a parked check so the caller keeps a clock running for it', () => {
    expect(
      hasPendingUsageRetry({
        provider: 'claude',
        error: 'rate limited',
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW + 60_000 }
      })
    ).toBe(true)
    expect(hasPendingUsageRetry({ provider: 'claude', error: 'rate limited' })).toBe(false)
    expect(hasPendingUsageRetry({ provider: 'claude', error: 'boom' })).toBe(false)
  })
})
