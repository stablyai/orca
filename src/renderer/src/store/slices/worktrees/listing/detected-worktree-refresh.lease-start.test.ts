import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetLeaseStart, rememberLeaseStart } from './detected-worktree-refresh'

describe('rememberLeaseStart', () => {
  afterEach(() => vi.useRealTimers())

  // Regression: the direct-SSH path recorded the start inside merge, after the provider completed,
  // so the first owner stamped completion time and every joiner inherited a time later than a
  // write that had landed mid-scan.
  it("keeps the first caller's clock for every later joiner of the same request", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const first = rememberLeaseStart('req-shared-start')
    vi.setSystemTime(9_000)
    const joiner = rememberLeaseStart('req-shared-start')

    expect(first).toBe(1_000)
    expect(joiner).toBe(1_000)
  })

  // Regression: entries expired by wall clock alone, so a joiner of a scan still running after
  // 60 s recorded a later start and a stale listing outranked a color written mid-scan.
  it('keeps the first clock while any holder is active and forgets it on the last release', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    expect(rememberLeaseStart('req-long')).toBe(1_000)
    vi.setSystemTime(1_000 + 5 * 60_000)
    expect(rememberLeaseStart('req-long')).toBe(1_000)
    forgetLeaseStart('req-long')
    expect(rememberLeaseStart('req-long')).toBe(1_000)
    forgetLeaseStart('req-long')
    forgetLeaseStart('req-long')
    vi.setSystemTime(2_000_000)
    expect(rememberLeaseStart('req-long')).toBe(2_000_000)
    forgetLeaseStart('req-long')
  })

  it('records a fresh start for a different request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    rememberLeaseStart('req-a-distinct')
    vi.setSystemTime(5_000)
    expect(rememberLeaseStart('req-b-distinct')).toBe(5_000)
  })
})
