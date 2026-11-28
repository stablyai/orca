import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteAtlasFontProbeMismatch,
  resetAtlasFontProbeRecoveryForTesting
} from './terminal-atlas-font-probe-recovery'

const MISMATCH_WINDOW_MS = 2_000
const MISMATCH_BURST_COOLDOWN_MS = 5_000
const scheduleBurst = vi.hoisted(() => vi.fn())

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleWebglAtlasRecoveryBurst: (...args: unknown[]) => scheduleBurst(...args)
}))

describe('noteAtlasFontProbeMismatch', () => {
  afterEach(() => {
    resetAtlasFontProbeRecoveryForTesting()
    scheduleBurst.mockClear()
    vi.useRealTimers()
  })

  it('schedules atlas recovery after a burst of mismatches', () => {
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).not.toHaveBeenCalled()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).toHaveBeenCalledOnce()
    expect(scheduleBurst).toHaveBeenCalledWith('atlas-font-probe-mismatch')
  })

  it('does not schedule recovery when mismatches are spread apart', () => {
    vi.useFakeTimers()
    noteAtlasFontProbeMismatch()
    vi.advanceTimersByTime(MISMATCH_WINDOW_MS + 1)
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).not.toHaveBeenCalled()
  })

  it('defers recovery when threshold is reached during cooldown', () => {
    vi.useFakeTimers()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).toHaveBeenCalledOnce()
    scheduleBurst.mockClear()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MISMATCH_BURST_COOLDOWN_MS)
    expect(scheduleBurst).toHaveBeenCalledOnce()
    expect(scheduleBurst).toHaveBeenCalledWith('atlas-font-probe-mismatch')
  })

  it('schedules deferred recovery after mismatches mid-cooldown', () => {
    vi.useFakeTimers()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).toHaveBeenCalledOnce()
    scheduleBurst.mockClear()
    vi.advanceTimersByTime(1_000)
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MISMATCH_BURST_COOLDOWN_MS - 1_000)
    expect(scheduleBurst).toHaveBeenCalledOnce()
  })

  it('allows another burst after cooldown with fresh mismatches', () => {
    vi.useFakeTimers()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    scheduleBurst.mockClear()
    vi.advanceTimersByTime(MISMATCH_BURST_COOLDOWN_MS)
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    noteAtlasFontProbeMismatch()
    expect(scheduleBurst).toHaveBeenCalledOnce()
  })
})