import { describe, expect, it } from 'vitest'
import {
  ROTATE_MAX_MS,
  ROTATE_MIN_MS,
  decideSessionFreshness,
  type SessionEpoch
} from './pet-session-epoch'

const T0 = 1_000_000
const fixedRandom = (): number => 0.5 // → threshold exactly at the band midpoint (2h)

describe('decideSessionFreshness', () => {
  it('continues (never rotates) on the very first spawn', () => {
    // No epoch yet = a thread may already be on disk from before epoch
    // tracking; rotating here would throw away a conversation the operator was
    // mid-way through. Start the clock, keep --continue.
    const { fresh, nextEpoch } = decideSessionFreshness(null, T0, fixedRandom)
    expect(fresh).toBe(false)
    expect(nextEpoch.startedAt).toBe(T0)
    expect(nextEpoch.thresholdMs).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
    expect(nextEpoch.thresholdMs).toBeLessThanOrEqual(ROTATE_MAX_MS)
  })

  it('continues while the epoch is younger than its threshold', () => {
    const epoch: SessionEpoch = { startedAt: T0, thresholdMs: 2 * 60 * 60 * 1000 }
    const { fresh, nextEpoch } = decideSessionFreshness(epoch, T0 + 90 * 60 * 1000, fixedRandom)
    expect(fresh).toBe(false)
    // The epoch is carried forward unchanged so the deadline does not drift.
    expect(nextEpoch).toBe(epoch)
  })

  it('rotates once the epoch outlives its threshold, and rearms', () => {
    const epoch: SessionEpoch = { startedAt: T0, thresholdMs: 2 * 60 * 60 * 1000 }
    const now = T0 + 2 * 60 * 60 * 1000 + 1
    const { fresh, nextEpoch } = decideSessionFreshness(epoch, now, fixedRandom)
    expect(fresh).toBe(true)
    // A fresh epoch starts now, so the next rotation is another 1–3h out, not
    // immediately again.
    expect(nextEpoch.startedAt).toBe(now)
    expect(nextEpoch.thresholdMs).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
  })

  it('draws every threshold inside the 1–3h band', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { nextEpoch } = decideSessionFreshness(null, T0, () => r)
      expect(nextEpoch.thresholdMs).toBeGreaterThanOrEqual(ROTATE_MIN_MS)
      expect(nextEpoch.thresholdMs).toBeLessThanOrEqual(ROTATE_MAX_MS)
    }
  })
})
