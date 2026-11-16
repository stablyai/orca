import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPRAutoRefreshCadencesForTests,
  setPRAutoRefreshCadenceForHost
} from '../../../../../../shared/source-control/hosted-review/review-refresh-policy'
import {
  createVisibleHostedReviewRefreshScheduler,
  type VisibleHostedReviewRefreshTarget
} from './visible-hosted-review-refresh-scheduler'
import { followOwningHostCadence } from './owning-host-cadence-replan'

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

describe('replanning on a host’s cadence change', () => {
  afterEach(() => _resetPRAutoRefreshCadencesForTests())

  it.each([750, 7500])(
    'builds no rows for a cadence change and re-plans only the changed host’s targets beside %i others',
    (rows) => {
      const aTargets = Array.from({ length: rows }, (_, row) =>
        target({
          key: `a-${row}`,
          cadenceHost: 'env-a',
          intervalMs: 120_000,
          foregroundIntervalMs: 120_000
        })
      )
      const bTarget = target({
        key: 'b',
        cadenceHost: 'env-b',
        intervalMs: 120_000,
        foregroundIntervalMs: 120_000
      })
      const build = vi.fn(() => [...aTargets, bTarget])
      const applied: (readonly VisibleHostedReviewRefreshTarget[])[] = []
      const following = followOwningHostCadence(build, (targets) => applied.push(targets))
      following.update()

      setPRAutoRefreshCadenceForHost('env-b', 'minimal')
      expect(build).toHaveBeenCalledTimes(1)
      const replanned = applied.at(-1)!
      expect(replanned.slice(0, rows).every((row, index) => row === aTargets[index])).toBe(true)
      expect(replanned[rows]).toMatchObject({ key: 'b', cadence: 'minimal', intervalMs: 1_200_000 })

      setPRAutoRefreshCadenceForHost('env-b', 'minimal')
      setPRAutoRefreshCadenceForHost('env-c', 'off')
      expect(applied).toHaveLength(2)

      setPRAutoRefreshCadenceForHost('env-a', 'reduced')
      expect(applied.at(-1)![0]).toMatchObject({ cadence: 'reduced', intervalMs: 600_000 })
      expect(applied.at(-1)![rows]).toBe(replanned[rows])

      following.dispose()
      setPRAutoRefreshCadenceForHost('env-b', 'off')
      expect(applied).toHaveLength(3)
      expect(build).toHaveBeenCalledTimes(1)
    }
  )
})
