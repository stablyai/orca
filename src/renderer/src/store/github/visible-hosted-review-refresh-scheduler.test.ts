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
        expect(row.refresh).toHaveBeenCalledTimes(1)
      }
      finish[0](false)
      await vi.advanceTimersByTimeAsync(0)
      if (action !== 'dispose') {
        expect(row.refresh).toHaveBeenCalledTimes(2)
        expect(signals[1]?.aborted).toBe(false)
        finish[1](true)
        await vi.advanceTimersByTimeAsync(0)
      }
    }
  )

  it('backs off preserved-cache failures from one minute to fifteen minutes', async () => {
    const row = target({
      fetchedAt: null,
      intervalMs: 60_000,
      selected: true,
      refresh: vi.fn(async () => false)
    })
    setup([row])
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const calls = vi.mocked(row.refresh).mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(row.refresh).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(row.refresh).toHaveBeenCalledTimes(calls + 1)
      expect(row.refresh).toHaveBeenLastCalledWith(true, expect.any(AbortSignal))
    }
  })

  it('caps concurrency at three and removes abandoned queued work', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<boolean>((resolve) => {
      release = () => resolve(true)
    })
    const rows = Array.from({ length: 10 }, (_, i) =>
      target({ key: String(i), fetchedAt: null, refresh: vi.fn(() => pending) })
    )
    const scheduler = setup(rows)
    expect(rows.slice(0, 3).every((row) => vi.mocked(row.refresh).mock.calls.length === 1)).toBe(
      true
    )
    expect(rows.slice(3).every((row) => vi.mocked(row.refresh).mock.calls.length === 0)).toBe(true)
    scheduler.update([rows[9]])
    release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(rows[9].refresh).toHaveBeenCalledTimes(1)
    expect(rows.slice(3, 9).every((row) => vi.mocked(row.refresh).mock.calls.length === 0)).toBe(
      true
    )
    scheduler.update([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leave timers when in-flight requests finish after cleanup', async () => {
    let release: (() => void) | undefined
    const row = target({
      fetchedAt: null,
      refresh: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true)
          })
      )
    })
    const scheduler = setup([row])
    scheduler.dispose()
    release?.()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps new-HEAD discovery when an older in-flight request writes the cache', async () => {
    let release: (() => void) | undefined
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true)
          })
      )
      .mockResolvedValue(true)
    let row = target({ fetchedAt: null, intervalMs: null, refresh })
    const scheduler = setup([row])
    row = { ...row, revision: 'new-head|' }
    scheduler.update([row])
    row = { ...row, fetchedAt: Date.now() }
    scheduler.update([row])
    release?.()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('failed discovery retains branch admission', () => {
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

  it('preserves error backoff when an unchanged distinct-head alias hides or returns', async () => {
    const refresh = vi.fn(async () => false)
    const both = target({
      fetchedAt: null,
      intervalMs: 60_000,
      refresh,
      revision: 'head-a;head-b',
      aliasRevisions: new Map([
        ['a', 'head-a'],
        ['b', 'head-b']
      ])
    })
    const scheduler = setup([both])
    await vi.advanceTimersByTimeAsync(0)
    const one = { ...both, revision: 'head-a', aliasRevisions: new Map([['a', 'head-a']]) }
    scheduler.update([one])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledOnce()
    scheduler.update([both])
    await vi.advanceTimersByTimeAsync(49_999)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
