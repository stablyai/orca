import { describe, expect, it } from 'vitest'
import { readAntigravityStatusLineQuota } from './antigravity-statusline-quota'

const NOW = Date.parse('2026-11-28T10:00:00Z')

function payload(quota: unknown): string {
  return JSON.stringify({
    cwd: '/tmp/work',
    model: { id: 'm', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    cycle_mode: 'auto',
    email: ' user@example.com ',
    quota
  })
}

describe('readAntigravityStatusLineQuota', () => {
  it('maps agy quota windows to session, weekly and named buckets', () => {
    const result = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': {
          remaining_fraction: 0.75,
          reset_time: '2026-11-28T12:00:00Z',
          reset_in_seconds: 7200
        },
        'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-12-01T00:00:00Z' },
        '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-11-28T11:00:00Z' },
        '3p-weekly': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }
      }),
      NOW
    )
    expect(result?.email).toBe('user@example.com')
    expect(result?.limits).toMatchObject({
      provider: 'antigravity',
      status: 'ok',
      error: null,
      updatedAt: NOW,
      session: {
        usedPercent: 25,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-11-28T12:00:00Z')
      },
      weekly: {
        usedPercent: 50,
        windowMinutes: 10080,
        resetsAt: Date.parse('2026-12-01T00:00:00Z')
      }
    })
    expect(result?.limits.buckets).toHaveLength(2)
    expect(result?.limits.buckets?.[0]).toMatchObject({ usedPercent: 90, windowMinutes: 300 })
    expect(result?.limits.buckets?.[1]).toMatchObject({
      usedPercent: 0,
      windowMinutes: 10080,
      resetsAt: null
    })
  })

  it('reads an untouched epoch window and a lapsed reset as 0% used with no reset time', () => {
    const result = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
        'gemini-weekly': { remaining_fraction: 0.2, reset_time: '2026-11-28T09:59:59Z' }
      }),
      NOW
    )
    expect(result?.limits.session).toMatchObject({ usedPercent: 0, resetsAt: null })
    expect(result?.limits.weekly).toMatchObject({ usedPercent: 0, resetsAt: null })
  })

  it('clamps an out-of-range remaining fraction', () => {
    const result = readAntigravityStatusLineQuota(
      payload({ 'gemini-5h': { remaining_fraction: -0.4, reset_time: '2026-11-28T12:00:00Z' } }),
      NOW
    )
    expect(result?.limits.session?.usedPercent).toBe(100)
  })

  it('returns null without a usable quota or for malformed input', () => {
    expect(readAntigravityStatusLineQuota(payload(undefined), NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota(payload({}), NOW)).toBeNull()
    expect(
      readAntigravityStatusLineQuota(payload({ 'gemini-5h': { reset_time: 'x' } }), NOW)
    ).toBeNull()
    expect(readAntigravityStatusLineQuota(payload('nope'), NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota('{not json', NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota('[]', NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota('null', NOW)).toBeNull()
  })

  it('leaves the email null when absent', () => {
    const result = readAntigravityStatusLineQuota(
      JSON.stringify({
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-28T12:00:00Z' } }
      }),
      NOW
    )
    expect(result?.email).toBeNull()
  })
})
