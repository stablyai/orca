import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGitStatusRefreshScheduler,
  type GitStatusRefreshReason
} from './git-status-refresh-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

function createScheduler(
  task: (request: { reason: GitStatusRefreshReason; signal: AbortSignal }) => Promise<void>
) {
  return createGitStatusRefreshScheduler(task, {
    safetyIntervalMs: 60_000,
    activityDebounceMs: 125,
    activityMinGapMs: 3000,
    slowTaskBackoff: {
      idleMultiplier: 5,
      changeSignalMultiplier: 1,
      maxIntervalMs: 5 * 60_000
    }
  })
}

describe('createGitStatusRefreshScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes immediately on resume and uses one 60-second safety timeout', async () => {
    vi.useFakeTimers()
    const reasons: GitStatusRefreshReason[] = []
    const task = vi.fn(async ({ reason }: { reason: GitStatusRefreshReason }) => {
      reasons.push(reason)
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    expect(task).toHaveBeenCalledTimes(1)
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(task).toHaveBeenCalledTimes(2)
    expect(reasons).toEqual(['activity', 'safety'])
  })

  it('coalesces activity signals and restarts the safety horizon', async () => {
    vi.useFakeTimers()
    const task = vi.fn(async () => {})
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(59_000)

    scheduler.signal()
    scheduler.signal()
    scheduler.signal()
    await vi.advanceTimersByTimeAsync(124)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(task).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('serializes in-flight work and retains one trailing activity refresh', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    let active = 0
    let maxActive = 0
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      active += 1
      maxActive = Math.max(maxActive, active)
      return call.promise.finally(() => {
        active -= 1
      })
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    scheduler.signal()
    scheduler.signal()
    scheduler.refreshNow()
    expect(task).toHaveBeenCalledTimes(1)

    calls[0]?.resolve()
    await flushMicrotasks()
    // Why: the trailing refresh respects the 3s activity floor from run end.
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)

    calls[1]?.resolve()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('spaces sustained signal bursts by the activity floor instead of running back-to-back', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    scheduler.signal()
    calls[0]?.resolve()
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)

    // A signal mid-flight plus immediate settle still waits out the floor.
    scheduler.signal()
    calls[1]?.resolve()
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('stretches activity and safety pacing after a slow scan', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    // The first scan takes 30 seconds; a signal arrives while it is running.
    scheduler.signal()
    await vi.advanceTimersByTimeAsync(30_000)
    calls[0]?.resolve()
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(1)

    // Trailing activity waits max(3s floor, 1x scan duration) = 30s.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)

    // The second scan is also slow; the next safety waits max(60s, 5x) = 150s.
    await vi.advanceTimersByTimeAsync(30_000)
    calls[1]?.resolve()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(149_999)
    expect(task).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('aborts on pause and catches up after the obsolete request settles', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const signals: AbortSignal[] = []
    const task = vi.fn(({ signal }: { signal: AbortSignal }) => {
      const call = deferred()
      calls.push(call)
      signals.push(signal)
      return call.promise
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    scheduler.pause()
    expect(signals[0]?.aborted).toBe(true)

    scheduler.resumeSafety()
    expect(task).toHaveBeenCalledTimes(1)
    calls[0]?.resolve()
    await flushMicrotasks()

    // Why: the reveal catch-up rides the paced activity lane (3s floor).
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(2)
    expect(signals[1]?.aborted).toBe(false)
    calls[1]?.resolve()
    await flushMicrotasks()
  })

  it('does not stretch catch-up pacing with an aborted slow scan duration', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    // A long scan is aborted by pause (window hide). Its wall time must not
    // become the next activity idle gap, or reveal catch-up waits tens of
    // seconds for work that never applied.
    await vi.advanceTimersByTimeAsync(30_000)
    scheduler.pause()
    scheduler.resumeSafety()
    calls[0]?.resolve()
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(2999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)
    calls[1]?.resolve()
    await flushMicrotasks()
  })

  it('keeps huge-status signal mode active without a safety timeout', async () => {
    vi.useFakeTimers()
    const task = vi.fn(async () => {})
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    await flushMicrotasks()
    scheduler.suspendSafety()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(task).toHaveBeenCalledTimes(1)

    scheduler.signal()
    await vi.advanceTimersByTimeAsync(125)
    expect(task).toHaveBeenCalledTimes(2)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('cleans up debounce and safety timers on dispose', async () => {
    vi.useFakeTimers()
    const task = vi.fn(async () => {})
    const scheduler = createScheduler(task)

    scheduler.resumeSafety()
    await flushMicrotasks()
    scheduler.signal()
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(task).toHaveBeenCalledTimes(1)
  })
})
