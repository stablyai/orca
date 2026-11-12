import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVisibleHostedReviewRefreshScheduler,
  type VisibleHostedReviewRefreshTarget
} from './visible-hosted-review-refresh-scheduler'

const schedulers: ReturnType<typeof createVisibleHostedReviewRefreshScheduler>[] = []

function setup(targets: VisibleHostedReviewRefreshTarget[]) {
  const scheduler = createVisibleHostedReviewRefreshScheduler()
  schedulers.push(scheduler)
  scheduler.update(targets)
  scheduler.setVisible(true)
  return scheduler
}

function target(
  overrides: Partial<VisibleHostedReviewRefreshTarget> = {}
): VisibleHostedReviewRefreshTarget {
  return {
    key: 'local::repo::branch',
    revision: 'head|',
    fetchedAt: Date.now(),
    intervalMs: 120_000,
    selected: false,
    refresh: vi.fn(async () => true),
    ...overrides
  }
}

describe('visible hosted review scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) {
      scheduler.dispose()
    }
    vi.useRealTimers()
  })

  it.each(['remove', 'hide', 'dispose'])(
    'aborts abandoned demand on %s without releasing native work early',
    async (action) => {
      const signals: (AbortSignal | undefined)[] = []
      const finish: ((value: boolean) => void)[] = []
      const row = target({
        fetchedAt: null,
        refresh: vi.fn((_force, signal) => {
          signals.push(signal)
          return new Promise<boolean>((resolve) => finish.push(resolve))
        })
      })
      const scheduler = setup([row])
      expect(signals[0]?.aborted).toBe(false)
      if (action === 'remove') {
        scheduler.update([])
      } else if (action === 'hide') {
        scheduler.setVisible(false)
      } else {
        scheduler.dispose()
      }
      expect(signals[0]?.aborted).toBe(true)
      if (action !== 'dispose') {
        scheduler.update([row])
        scheduler.setVisible(true)
        await vi.advanceTimersByTimeAsync(10_000)
      }
      finish[0](false)
      await vi.advanceTimersByTimeAsync(0)
      if (action !== 'dispose') {
        expect(signals[1]?.aborted).toBe(false)
        finish[1](true)
        await vi.advanceTimersByTimeAsync(0)
      }
    }
  )

  it('does not retry a failed read on a timer when the owning host’s cadence is off', async () => {
    const refresh = vi.fn(async () => false)
    setup([target({ fetchedAt: null, intervalMs: null, cadence: 'off', selected: true, refresh })])
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still retries a failed read with backoff when the cadence is not off', async () => {
    const refresh = vi.fn(async () => false)
    setup([target({ fetchedAt: null, intervalMs: null, cadence: 'default', refresh })])
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('marks a window-return read as foreground and a timer tick as not', async () => {
    const calls: boolean[] = []
    const refresh = vi.fn(async (_force?: boolean, _signal?: AbortSignal, foreground = false) => {
      calls.push(foreground)
      return true
    })
    const scheduler = setup([
      target({ fetchedAt: Date.now() - 30_000, intervalMs: 60_000, refresh })
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toEqual([false])
    scheduler.setVisible(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([false, true])
  })

  it('marks a read after the branch identity changed as foreground', async () => {
    const calls: boolean[] = []
    const refresh = vi.fn(async (_force?: boolean, _signal?: AbortSignal, foreground = false) => {
      calls.push(foreground)
      return true
    })
    const row = target({ fetchedAt: Date.now(), intervalMs: null, cadence: 'off', refresh })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    scheduler.update([{ ...row, revision: 'head-2|' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([true])
  })

  describe('a cadence change reconciles a retry armed after a failure', () => {
    it('drops a queued error retry when the owning host’s cadence becomes off', async () => {
      const refresh = vi.fn(async () => false)
      const row = target({ fetchedAt: null, intervalMs: 60_000, cadence: 'default', refresh })
      const scheduler = setup([row])
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      scheduler.update([{ ...row, cadence: 'off', intervalMs: null }])
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('re-times a queued error retry to a stretched cadence', async () => {
      const refresh = vi.fn(async () => false)
      const row = target({ fetchedAt: null, intervalMs: 60_000, cadence: 'default', refresh })
      const scheduler = setup([row])
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      scheduler.update([{ ...row, cadence: 'reduced', intervalMs: 5 * 60_000 }])
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect(refresh).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(refresh).toHaveBeenCalledTimes(2)
    })

    it('arms a retry for a read that failed under off once the cadence is enabled again', async () => {
      const refresh = vi.fn(async () => false)
      const row = target({ fetchedAt: null, intervalMs: null, cadence: 'off', refresh })
      const scheduler = setup([row])
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(refresh).toHaveBeenCalledTimes(1)
      scheduler.update([{ ...row, cadence: 'default', intervalMs: 60_000 }])
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(2)
    })

    it('a target that comes back after failing retries by the cadence it comes back with', async () => {
      const refresh = vi.fn(async () => false)
      // Fetched 31 s ago with a 30 s interval: due now, and not yet stale enough (60 s) for a
      // re-added target to read once on its own when it comes back.
      const row = target({
        fetchedAt: Date.now() - 31_000,
        intervalMs: 30_000,
        cadence: 'default',
        refresh
      })
      const scheduler = setup([row])
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      scheduler.update([])
      scheduler.update([{ ...row, cadence: 'off', intervalMs: null }])
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(refresh).toHaveBeenCalledTimes(1)
    })
  })

  describe('window return under a stretched cadence', () => {
    function reducedRow(calls: boolean[]) {
      return target({
        fetchedAt: Date.now(),
        intervalMs: 5 * 60_000,
        foregroundIntervalMs: 60_000,
        cadence: 'reduced',
        selected: true,
        refresh: vi.fn(async (_force?: boolean, _signal?: AbortSignal, foreground = false) => {
          calls.push(foreground)
          return true
        })
      })
    }

    it('reads at once as a foreground read, then waits the stretched interval', async () => {
      const calls: boolean[] = []
      const scheduler = setup([reducedRow(calls)])
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([])
      scheduler.setVisible(false)
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      scheduler.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([true])

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000)
      expect(calls).toEqual([true])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toEqual([true, false])
    })

    it('does not read on a return sooner than the Default interval', async () => {
      const calls: boolean[] = []
      const scheduler = setup([reducedRow(calls)])
      scheduler.setVisible(false)
      await vi.advanceTimersByTimeAsync(30_000)
      scheduler.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([])
    })
  })
})
