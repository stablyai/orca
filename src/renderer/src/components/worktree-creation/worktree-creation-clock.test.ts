import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ getIntlLocale: () => 'en' }))

import { buildClockElapsedMs, formatElapsedTime } from './worktree-creation-clock'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatElapsedTime', () => {
  it('formats with Intl in the given locale and keeps minutes once past an hour', () => {
    expect(formatElapsedTime(5_000, 'en')).toBe('5s')
    expect(formatElapsedTime(125_000, 'en')).toBe('2m 5s')
    expect(formatElapsedTime(3_605_000, 'en')).toBe('1h 0m 5s')
    expect(formatElapsedTime(125_000, 'de')).toBe('2 Min., 5 Sek.')
  })

  it('falls back to the same English shape where Intl.DurationFormat is missing', () => {
    vi.stubGlobal('Intl', { ...Intl, DurationFormat: undefined })
    // A locale no earlier call cached, so the stub decides.
    expect(formatElapsedTime(5_000, 'en-x-fallback')).toBe('5s')
    expect(formatElapsedTime(125_000, 'en-x-fallback')).toBe('2m 5s')
    expect(formatElapsedTime(3_605_000, 'en-x-fallback')).toBe('1h 0m 5s')
  })
})

describe('buildClockElapsedMs', () => {
  const T0 = 1_000_000
  const base = { startedAt: T0, status: 'creating' as const }

  it('stops while failed checks wait, resumes where it stopped, and starts over on Try again', () => {
    // Checks fail 10s in; the user waits 50s.
    const waiting = { ...base, waitingSince: T0 + 10_000 }
    expect(buildClockElapsedMs(waiting, T0 + 60_000)).toBe(10_000)
    // Retry checks at 60s: the wait is folded away.
    const resumed = { ...base, pausedMs: 50_000, resumedAt: T0 + 60_000 }
    // A stale tick from before the resume never reads below the frozen value.
    expect(buildClockElapsedMs(resumed, T0 + 30_000)).toBe(10_000)
    expect(buildClockElapsedMs(resumed, T0 + 65_000)).toBe(15_000)
    // Checks fail again 5s later; another 100s wait stays frozen at 15s.
    const waitingAgain = { ...resumed, waitingSince: T0 + 65_000 }
    expect(buildClockElapsedMs(waitingAgain, T0 + 165_000)).toBe(15_000)
    // Try again starts a new run with its own clock.
    const retried = { startedAt: T0 + 200_000, status: 'creating' as const }
    expect(buildClockElapsedMs(retried, T0 + 203_000)).toBe(3_000)
  })

  it('stops at an error', () => {
    expect(
      buildClockElapsedMs({ ...base, status: 'error', errorAt: T0 + 7_000 }, T0 + 99_000)
    ).toBe(7_000)
  })
})
