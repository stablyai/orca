import { describe, expect, it } from 'vitest'
import { normalizeSleepyModeIdleMinutes, sleepyModeIdleDelayMs } from './sleepy-mode-settings'

describe('normalizeSleepyModeIdleMinutes', () => {
  it('keeps offered options', () => {
    expect(normalizeSleepyModeIdleMinutes(15)).toBe(15)
  })

  it('falls back to off for unknown, missing, or hostile values', () => {
    expect(normalizeSleepyModeIdleMinutes(7)).toBe(0)
    expect(normalizeSleepyModeIdleMinutes(undefined)).toBe(0)
    expect(normalizeSleepyModeIdleMinutes(Number.NaN)).toBe(0)
    expect(normalizeSleepyModeIdleMinutes(-30)).toBe(0)
    expect(normalizeSleepyModeIdleMinutes('15')).toBe(0)
  })

  it('converts minutes to milliseconds', () => {
    expect(sleepyModeIdleDelayMs(5)).toBe(300_000)
    expect(sleepyModeIdleDelayMs(0)).toBe(0)
  })
})
