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
})
