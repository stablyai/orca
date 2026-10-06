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

  it('paces selected and other branches independently with one timer', async () => {
    const selected = target({ key: 'selected', intervalMs: 60_000, selected: true })
    const other = target()
    setup([selected, other])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(selected.refresh).toHaveBeenCalledTimes(1)
    expect(other.refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(selected.refresh).toHaveBeenCalledTimes(2)
    expect(other.refresh).toHaveBeenCalledTimes(1)
    expect(selected.refresh).toHaveBeenCalledWith(false)
    expect(other.refresh).toHaveBeenCalledWith(false)
  })

  it('starts no hidden or offscreen requests and removes timers on disposal', async () => {
    const row = target({ fetchedAt: null })
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    schedulers.push(scheduler)
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).not.toHaveBeenCalled()
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    expect(row.refresh).toHaveBeenCalledWith(true)
    scheduler.setVisible(false)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.update([])
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops settled merged reviews and refreshes a stale revisible review once', async () => {
    let row = target({ intervalMs: null })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(row.refresh).not.toHaveBeenCalled()
    scheduler.update([])
    row = {
      ...row,
      refresh: vi.fn(async () => {
        row = { ...row, fetchedAt: Date.now() }
        scheduler.update([row])
        return true
      })
    }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(0)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) {
      scheduler.update([{ ...row }])
    }
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps cooldown across removal and retimes HEAD/link discovery and selected tier', async () => {
    let row = target({ fetchedAt: null })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    scheduler.update([])
    row = { ...row, revision: 'new-head|github:8' }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(9_999)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(row.refresh).toHaveBeenCalledTimes(2)
    row = { ...row, fetchedAt: Date.now(), intervalMs: 60_000, selected: true }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(row.refresh).toHaveBeenCalledTimes(3)
  })

  it('does not let repeated reports or cache writes trigger immediate refreshes', async () => {
    let row = target()
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 20; i++) {
      scheduler.update([{ ...row }])
    }
    row = { ...row, fetchedAt: Date.now() }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(119_999)
    expect(row.refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(row.refresh).toHaveBeenCalledTimes(1)
  })

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
      expect(row.refresh).toHaveBeenLastCalledWith(true)
    }
  })

  it('retimes settled cache transitions and resets backoff after fresh evidence', async () => {
    let row = target({ fetchedAt: null, refresh: vi.fn(async () => false) })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    row = { ...row, fetchedAt: Date.now(), intervalMs: null }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
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

  it('retries a failed settled-review reprobe and stops after success', async () => {
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const row = target({ intervalMs: null, fetchedAt: Date.now() - 60_000, refresh })
    setup([row])
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(900_000)
    expect(refresh).toHaveBeenCalledTimes(2)
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

  it('keeps offscreen failure gates across HEAD changes and clears them with fresh evidence', async () => {
    let row = target({ fetchedAt: null, refresh: vi.fn(async () => false) })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    scheduler.update([])
    row = { ...row, revision: 'new-head|' }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(119_999)
    expect(row.refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(row.refresh).toHaveBeenCalledTimes(2)
    scheduler.update([])
    row = { ...row, fetchedAt: Date.now(), intervalMs: null }
    scheduler.update([row])
    await vi.advanceTimersByTimeAsync(900_000)
    expect(row.refresh).toHaveBeenCalledTimes(2)
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

  it('retains retry deadlines across real HEAD discovery changes', async () => {
    const refresh = vi.fn(async () => false)
    const row = target({ fetchedAt: null, intervalMs: 60_000, refresh })
    const scheduler = setup([row])
    await vi.advanceTimersByTimeAsync(0)
    scheduler.update([{ ...row, revision: 'new-head' }])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not retry a closed or unselected empty branch faster than fifteen minutes', async () => {
    const refresh = vi.fn(async () => false)
    setup([target({ fetchedAt: null, intervalMs: 900_000, refresh })])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(899_999)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
