import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createGitStatusRefreshScheduler } from './git-status-refresh-scheduler'

const options = {
  safetyIntervalMs: 60_000,
  activityDebounceMs: 125,
  activityMinGapMs: 3000,
  slowTaskBackoff: { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

it('rejects late hidden signals and catches up after an aborted read settles', async () => {
  const reads: AbortSignal[] = []
  let finish: (() => void) | undefined
  const scheduler = createGitStatusRefreshScheduler(({ signal }) => {
    reads.push(signal)
    return reads.length === 1
      ? new Promise<void>((resolve) => {
          finish = resolve
        })
      : Promise.resolve()
  }, options)
  scheduler.resumeSafety()
  scheduler.pause()
  expect(reads[0].aborted).toBe(true)
  scheduler.signal()
  scheduler.refreshNow()
  scheduler.retime()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toHaveLength(1)
  scheduler.resumeSafety()
  finish?.()
  await vi.advanceTimersByTimeAsync(3000)
  expect(reads).toHaveLength(2)
  scheduler.pause()
  scheduler.signal()
  scheduler.refreshNow()
  await vi.advanceTimersByTimeAsync(300_000)
  expect(reads).toHaveLength(2)
  scheduler.resumeSafety()
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toHaveLength(3)
  scheduler.dispose()
})

it('paces visible unfocused edits at 60s while retaining 240s safety and focused catch-up', async () => {
  let focused = false
  const reads: number[] = []
  const scheduler = createGitStatusRefreshScheduler(
    async () => {
      reads.push(Date.now())
    },
    {
      ...options,
      cadenceScale: () => (focused ? 1 : 4),
      activityCadenceScale: () => (focused ? 1 : 20)
    }
  )
  scheduler.resumeSafety()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 5; i++) {
    scheduler.signal()
    await vi.advanceTimersByTimeAsync(12_000)
  }
  expect(reads).toEqual([0, 60_000])
  await vi.advanceTimersByTimeAsync(240_000)
  expect(reads).toEqual([0, 60_000, 300_000])
  scheduler.signal()
  await vi.advanceTimersByTimeAsync(10_000)
  focused = true
  scheduler.retime()
  await vi.advanceTimersByTimeAsync(125)
  expect(reads).toEqual([0, 60_000, 300_000, 310_125])
  scheduler.dispose()
})

it('retains quiet-failure safety retry and one trailing read for an in-flight wake', async () => {
  const reads: number[] = []
  let finish: (() => void) | undefined
  const scheduler = createGitStatusRefreshScheduler(() => {
    reads.push(Date.now())
    if (reads.length === 1) {
      return Promise.reject(new Error('offline'))
    }
    if (reads.length === 2) {
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    return Promise.resolve()
  }, options)
  scheduler.resumeSafety()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toEqual([0, 60_000])
  scheduler.refreshNow()
  scheduler.signal()
  finish?.()
  await vi.advanceTimersByTimeAsync(3000)
  expect(reads).toEqual([0, 60_000, 63_000])
  scheduler.dispose()
})
