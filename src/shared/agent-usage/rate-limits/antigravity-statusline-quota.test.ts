import { describe, expect, it } from 'vitest'
import {
  antigravityBarProvider,
  readAntigravityStatusLinePost,
  readAntigravityStatusLineQuota
} from './antigravity-statusline-quota'

const NOW = Date.parse('2026-11-28T10:00:00Z')

function payload(quota: unknown): object {
  return {
    cwd: '/tmp/work',
    model: { id: 'm', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    cycle_mode: 'auto',
    email: 'user@example.com',
    quota
  }
}

describe('readAntigravityStatusLineQuota', () => {
  it('keeps every present pool as its own named window', () => {
    const reading = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-11-28T12:00:00Z' },
        'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-12-01T00:00:00Z' },
        '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-11-28T11:00:00Z' },
        // Same value and reset as Gemini's weekly pool: still a separate pool.
        '3p-weekly': { remaining_fraction: 0.5, reset_time: '2026-12-01T00:00:00Z' }
      }),
      NOW
    )
    expect(reading).toMatchObject({
      provider: 'antigravity',
      status: 'ok',
      updatedAt: NOW,
      session: { usedPercent: 25, windowMinutes: 300 },
      weekly: { usedPercent: 50, windowMinutes: 10080 }
    })
    expect(reading?.buckets?.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
      ['Gemini 5h', 25],
      ['Gemini weekly', 50],
      ['Claude · GPT 5h', 90],
      ['Claude · GPT weekly', 50]
    ])
    expect(JSON.stringify(reading)).not.toContain('example.com')
  })

  it('reads an epoch or lapsed reset as unused, but keeps the fraction for a bad reset time', () => {
    const reading = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
        'gemini-weekly': { remaining_fraction: 0.2, reset_time: '2026-11-28T09:59:59Z' },
        '3p-5h': { remaining_fraction: 0.1, reset_time: 'not a date' },
        '3p-weekly': { remaining_fraction: 0.4 }
      }),
      NOW
    )
    // Numbers and impossible dates are not instants, whatever Date.parse makes of them.
    const odd = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': { remaining_fraction: 0.1, reset_time: '0' },
        'gemini-weekly': { remaining_fraction: 0.1, reset_time: '2026-02-30T10:00:00Z' }
      }),
      NOW
    )
    expect(odd?.session).toMatchObject({ usedPercent: 90, resetsAt: null })
    expect(odd?.weekly).toMatchObject({ usedPercent: 90, resetsAt: null })
    expect(reading?.session).toMatchObject({ usedPercent: 0, resetsAt: null })
    expect(reading?.weekly).toMatchObject({ usedPercent: 0, resetsAt: null })
    expect(reading?.buckets?.[2]).toMatchObject({ usedPercent: 90, resetsAt: null })
    expect(reading?.buckets?.[3]).toMatchObject({ usedPercent: 60, resetsAt: null })
  })

  it('omits a disabled pool and clamps an out-of-range fraction', () => {
    const reading = readAntigravityStatusLineQuota(
      payload({
        'gemini-5h': { remaining_fraction: -0.4, reset_time: '2026-11-28T12:00:00Z' },
        '3p-5h': { remaining_fraction: 0.5, reset_time: '2026-11-28T12:00:00Z', disabled: true }
      }),
      NOW
    )
    expect(reading?.session?.usedPercent).toBe(100)
    expect(reading?.buckets?.map((bucket) => bucket.name)).toEqual(['Gemini 5h'])
  })

  it('returns null without a quota object', () => {
    expect(readAntigravityStatusLineQuota(payload(undefined), NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota(payload('nope'), NOW)).toBeNull()
    expect(readAntigravityStatusLineQuota(payload([]), NOW)).toBeNull()
  })

  it('reads a quota object with no usable pool as an empty reading, so held values can be cleared', () => {
    for (const quota of [
      {},
      { 'gemini-5h': { reset_time: 'x' } },
      { 'gemini-5h': { remaining_fraction: 1, disabled: true } },
      { 'gemini-5h': [{ remaining_fraction: 0.5 }] }
    ]) {
      expect(readAntigravityStatusLineQuota(payload(quota), NOW)?.buckets).toEqual([])
    }
  })
})

describe('readAntigravityStatusLinePost', () => {
  it('reads the posted form once and rejects a payload that is not an object', () => {
    const quota = { 'gemini-5h': { remaining_fraction: 0.5, reset_time: '2999-01-01T00:00:00Z' } }
    expect(
      readAntigravityStatusLinePost({ payload: JSON.stringify(payload(quota)) }, NOW)?.session
    ).toMatchObject({ usedPercent: 50 })
    expect(readAntigravityStatusLinePost({ payload: '{not json' }, NOW)).toBeNull()
    expect(readAntigravityStatusLinePost({ payload: '[]' }, NOW)).toBeNull()
    expect(readAntigravityStatusLinePost({}, NOW)).toBeNull()
  })
})

describe('antigravityBarProvider', () => {
  const quota = {
    'gemini-5h': { remaining_fraction: 0.6, reset_time: '2026-11-28T12:00:00Z' },
    'gemini-weekly': { remaining_fraction: 0.4, reset_time: '2026-12-01T00:00:00Z' },
    '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-11-28T11:00:00Z' },
    '3p-weekly': { remaining_fraction: 0.2, reset_time: '2026-12-02T00:00:00Z' }
  }

  it('draws Gemini 5h and weekly as plain windows, leaving the pools to the menus', () => {
    const reading = readAntigravityStatusLineQuota(payload(quota), NOW)
    const bar = antigravityBarProvider(reading!)
    expect(bar.buckets).toBeUndefined()
    expect(bar.session?.usedPercent).toBe(40)
    expect(bar.weekly?.usedPercent).toBe(60)
    expect(reading?.buckets).toHaveLength(4)
  })

  it('falls back to the third-party pool when Gemini reports no window', () => {
    const reading = readAntigravityStatusLineQuota(
      payload({ '3p-5h': quota['3p-5h'], '3p-weekly': quota['3p-weekly'] }),
      NOW
    )
    const bar = antigravityBarProvider(reading!)
    expect(bar.session).toMatchObject({ usedPercent: 90, windowMinutes: 300 })
    expect(bar.weekly).toMatchObject({ usedPercent: 80, windowMinutes: 10080 })
    expect(bar.session).not.toHaveProperty('name')
    const weeklyOnly = antigravityBarProvider(
      readAntigravityStatusLineQuota(payload({ '3p-weekly': quota['3p-weekly'] }), NOW)!
    )
    expect(weeklyOnly.session).toBeNull()
    expect(weeklyOnly.weekly?.usedPercent).toBe(80)
  })
})
