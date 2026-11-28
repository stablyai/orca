import { describe, expect, it } from 'vitest'
import {
  pruneEndedUsageHistory,
  recordUsageWindowSample,
  USAGE_HISTORY_MAX_SAMPLES,
  type UsageWindowHistory
} from './usage-window-history'

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const WEEK_MINUTES = 7 * 24 * 60
const weekly = (usedPercent: number, resetsAt = NOW + 5 * 24 * 60 * MINUTE) => ({
  usedPercent,
  windowMinutes: WEEK_MINUTES,
  resetsAt
})

describe('recordUsageWindowSample', () => {
  it('keeps a series across reset jitter and starts afresh after a reset', () => {
    let series = recordUsageWindowSample(undefined, weekly(10), NOW)
    series = recordUsageWindowSample(
      series,
      weekly(12, NOW + 5 * 24 * 60 * MINUTE + 30_000),
      NOW + 120 * MINUTE
    )
    expect(series.samples.map((s) => s.usedPercent)).toEqual([10, 12])
    const next = recordUsageWindowSample(
      series,
      weekly(1, NOW + 12 * 24 * 60 * MINUTE),
      NOW + 240 * MINUTE
    )
    expect(next.samples).toEqual([{ at: NOW + 240 * MINUTE, usedPercent: 1 }])
  })

  it('ignores a reading no newer than the last one', () => {
    const series = recordUsageWindowSample(undefined, weekly(10), NOW)
    expect(recordUsageWindowSample(series, weekly(11), NOW).samples).toHaveLength(1)
  })

  it('stays bounded however often usage is read', () => {
    let series: UsageWindowHistory | undefined
    // A reading every minute for five days.
    for (let i = 0; i < 5 * 24 * 60; i++) {
      series = recordUsageWindowSample(series, weekly(i / 100), NOW + i * MINUTE)
    }
    expect(series!.samples.length).toBeLessThanOrEqual(USAGE_HISTORY_MAX_SAMPLES)
    expect(series!.samples.at(-1)).toEqual({
      at: NOW + (5 * 24 * 60 - 1) * MINUTE,
      usedPercent: 71.99
    })
    const times = series!.samples.map((s) => s.at)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    // Older points thin out instead of falling off, so the line still starts at the first reading.
    expect(times[0]).toBe(NOW)
  })

  it('drops series whose window has ended', () => {
    const live = recordUsageWindowSample(undefined, weekly(10), NOW)
    const ended = recordUsageWindowSample(undefined, weekly(10, NOW + MINUTE), NOW)
    const kept = pruneEndedUsageHistory({ live, ended }, NOW + 2 * MINUTE)
    expect(Object.keys(kept)).toEqual(['live'])
  })
})
