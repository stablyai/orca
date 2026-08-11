import { describe, expect, it } from 'vitest'

import { formatSshRelayGraceDuration } from './ssh-relay-grace-duration'

describe('formatSshRelayGraceDuration', () => {
  it('keeps a single unit when the value divides evenly', () => {
    expect(formatSshRelayGraceDuration(86_400)).toBe('1d')
    expect(formatSshRelayGraceDuration(604_800)).toBe('7d')
    expect(formatSshRelayGraceDuration(10_800)).toBe('3h')
    expect(formatSshRelayGraceDuration(60)).toBe('1m')
  })

  it('adds the next unit down instead of falling back to a huge count', () => {
    // 600000s is the shape of a milliseconds-for-seconds typo: it passes the
    // 60..604800 bounds, and the single-unit format rendered it as "10000m".
    expect(formatSshRelayGraceDuration(600_000)).toBe('6d 22h')
    expect(formatSshRelayGraceDuration(5_400)).toBe('1h 30m')
    expect(formatSshRelayGraceDuration(90)).toBe('1m 30s')
  })

  it('never reports a larger unit than the value holds', () => {
    expect(formatSshRelayGraceDuration(59)).toBe('59s')
    expect(formatSshRelayGraceDuration(0)).toBe('0s')
  })

  it('rejects values that are not a usable second count', () => {
    expect(formatSshRelayGraceDuration(-1)).toBe(null)
    expect(formatSshRelayGraceDuration(Number.NaN)).toBe(null)
    expect(formatSshRelayGraceDuration(1.5)).toBe(null)
  })
})
