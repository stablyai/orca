import { describe, expect, it, vi } from 'vitest'
import {
  createDownloadProgressTracker,
  DOWNLOAD_PROGRESS_INTERVAL_MS
} from './download-progress-tracker'

describe('createDownloadProgressTracker', () => {
  function setup(totalBytes: number | null = 100) {
    let now = 0
    const emit = vi.fn()
    const tracker = createDownloadProgressTracker({ totalBytes, emit, now: () => now })
    return {
      tracker,
      emit,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  it('emits the first update immediately and coalesces updates inside the interval', () => {
    const { tracker, emit, advance } = setup()
    tracker.addBytes(10)
    tracker.addBytes(10)
    tracker.addBytes(10)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenLastCalledWith({ transferredBytes: 10, totalBytes: 100 })

    advance(DOWNLOAD_PROGRESS_INTERVAL_MS)
    tracker.addBytes(5)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith({ transferredBytes: 35, totalBytes: 100 })
  })

  it('flushes the latest total even inside the interval, but only when it changed', () => {
    const { tracker, emit } = setup(null)
    tracker.addBytes(4)
    tracker.addBytes(6)
    tracker.flush()
    expect(emit).toHaveBeenLastCalledWith({ transferredBytes: 10, totalBytes: null })
    const calls = emit.mock.calls.length
    tracker.flush()
    expect(emit).toHaveBeenCalledTimes(calls)
  })

  it('ignores empty and invalid byte counts', () => {
    const { tracker, emit } = setup()
    tracker.flush()
    tracker.addBytes(0)
    tracker.addBytes(-3)
    tracker.addBytes(Number.NaN)
    tracker.flush()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenLastCalledWith({ transferredBytes: 0, totalBytes: 100 })
  })
})
