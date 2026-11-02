import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollWorkerAutoClose, type WorkerAutoCloseState } from './worker-auto-close'

describe('pollWorkerAutoClose', () => {
  afterEach(() => vi.useRealTimers())

  it('re-reads a temporary worker every 15 seconds and others every minute, so a later change shows', async () => {
    vi.useFakeTimers()
    const states: (WorkerAutoCloseState | null)[] = [
      { kept: false, closesAt: null },
      { kept: true },
      null,
      { kept: false, closesAt: '2026-10-27T12:02:00Z' }
    ]
    const seen: (WorkerAutoCloseState | null)[] = []
    const read = vi.fn(async () => states.shift() ?? null)
    const stop = pollWorkerAutoClose(read, (state) => seen.push(state))

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(seen.at(-1)).toEqual({ kept: false, closesAt: '2026-10-27T12:02:00Z' })
    stop()
  })
})
