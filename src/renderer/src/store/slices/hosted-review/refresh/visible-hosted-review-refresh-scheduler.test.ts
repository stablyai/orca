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

  it('retrieves a deferred completion with an ordinary timer read and resets on a head change', async () => {
    const refresh = vi.fn(async () => ({ succeeded: true, retryAfterMs: 10_000 }))
    const row = target({ fetchedAt: Date.now() - 120_000, refresh })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls[0]).toEqual([true, expect.any(AbortSignal), 'discovery'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh.mock.calls[1]).toEqual([false, expect.any(AbortSignal), 'timer'])
    scheduler.update([{ ...row, revision: 'new-head|' }])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh.mock.calls[2]).toEqual([true, expect.any(AbortSignal), 'discovery'])
  })

  it('keeps successful same-age cache replies on the normal interval without a receipt', async () => {
    const refresh = vi.fn(async () => ({ succeeded: true }))
    setup([target({ fetchedAt: Date.now() - 120_000, refresh })])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh.mock.calls[1]).toEqual([false, expect.any(AbortSignal), 'timer'])
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

it('limits refocus discovery to opted-in open GitHub rows and the existing stopped interval', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const github = target({
    key: 'github',
    fetchedAt: Date.now(),
    intervalMs: 120_000,
    refreshOnForeground: true
  })
  const closed = target({ key: 'closed', fetchedAt: Date.now(), intervalMs: 900_000 })
  const other = target({ key: 'other', fetchedAt: Date.now(), intervalMs: 120_000 })
  const stopped = target({ key: 'stopped', fetchedAt: Date.now(), intervalMs: null })
  const scheduler = setup([github, closed, other, stopped])
  scheduler.setVisible(false)
  await vi.advanceTimersByTimeAsync(130_000)
  scheduler.setVisible(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(github.refresh).toHaveBeenCalledWith(true, expect.any(AbortSignal), 'discovery')
  expect(stopped.refresh).toHaveBeenCalledWith(true, expect.any(AbortSignal), 'discovery')
  expect(closed.refresh).not.toHaveBeenCalled()
  expect(other.refresh).toHaveBeenCalledWith(false, expect.any(AbortSignal), 'timer')
  scheduler.dispose()
  vi.useRealTimers()
})
