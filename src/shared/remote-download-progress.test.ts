import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteDownloadProgressTracker,
  REMOTE_DOWNLOAD_PROGRESS_INTERVAL_MS
} from './remote-download-progress'

describe('createRemoteDownloadProgressTracker', () => {
  function setup(totalBytes: number | null = 100) {
    let now = 0
    const emit = vi.fn()
    const tracker = createRemoteDownloadProgressTracker({
      downloadId: 'd1',
      totalBytes,
      emit,
      now: () => now
    })
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
    expect(emit).toHaveBeenLastCalledWith({
      downloadId: 'd1',
      transferredBytes: 10,
      totalBytes: 100,
      completedFiles: 0
    })

    advance(REMOTE_DOWNLOAD_PROGRESS_INTERVAL_MS)
    tracker.addBytes(5)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ transferredBytes: 35 }))
  })

  it('flushes the latest totals even inside the interval, but only when they changed', () => {
    const { tracker, emit } = setup(null)
    tracker.addBytes(4)
    tracker.addBytes(6)
    tracker.completeFile()
    tracker.flush()
    expect(emit).toHaveBeenLastCalledWith({
      downloadId: 'd1',
      transferredBytes: 10,
      totalBytes: null,
      completedFiles: 1
    })
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
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ transferredBytes: 0 }))
  })
})
