import { describe, expect, it, vi } from 'vitest'
import { type CoalescedPollRunner, createCoalescedPollRunner } from './coalesced-poll-runner'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createCoalescedPollRunner', () => {
  it('keeps one task in flight and runs one trailing task after skipped triggers', async () => {
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const runner = createCoalescedPollRunner(task)

    runner.run()
    runner.run()
    runner.run()
    await flushMicrotasks()

    expect(task).toHaveBeenCalledTimes(1)
    calls[0]?.resolve()
    await flushMicrotasks()

    expect(task).toHaveBeenCalledTimes(2)
    calls[1]?.resolve()
    await flushMicrotasks()
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('drops queued trailing work after disposal', async () => {
    const call = deferred()
    const task = vi.fn(() => call.promise)
    const runner = createCoalescedPollRunner(task)

    runner.run()
    runner.run()
    runner.dispose()
    call.resolve()
    await flushMicrotasks()

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('enforces minIntervalMs delay between consecutive runs', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const runner = createCoalescedPollRunner(task, { minIntervalMs: 1000 })

    runner.run()
    expect(task).toHaveBeenCalledTimes(1)

    runner.run()
    expect(task).toHaveBeenCalledTimes(1)

    calls[0]?.resolve()
    await flushMicrotasks()

    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(task).toHaveBeenCalledTimes(2)

    calls[1]?.resolve()
    await flushMicrotasks()
    vi.useRealTimers()
  })

  describe('slowTaskBackoff', () => {
    const BACKOFF = { idleMultiplier: 5, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }

    function makeSlowRunner(): {
      runner: CoalescedPollRunner
      task: ReturnType<typeof vi.fn>
      calls: ReturnType<typeof deferred>[]
    } {
      const calls: ReturnType<typeof deferred>[] = []
      const task = vi.fn(() => {
        const call = deferred()
        calls.push(call)
        return call.promise
      })
      const runner = createCoalescedPollRunner(task, {
        minIntervalMs: 3000,
        slowTaskBackoff: BACKOFF
      })
      return { runner, task, calls }
    }

    async function completeRunOfDuration(
      runner: CoalescedPollRunner,
      calls: ReturnType<typeof deferred>[],
      durationMs: number
    ): Promise<void> {
      runner.run()
      await vi.advanceTimersByTimeAsync(durationMs)
      calls.at(-1)?.resolve()
      await flushMicrotasks()
    }

    it('scales the tick idle gap with the previous run duration', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      // A 35s run (large-monorepo git status) with poll ticks arriving during it.
      runner.run()
      runner.run()
      await vi.advanceTimersByTimeAsync(35_000)
      calls[0]?.resolve()
      await flushMicrotasks()
      expect(task).toHaveBeenCalledTimes(1)

      // Ticks during the backoff window must not start a run early.
      await vi.advanceTimersByTimeAsync(3000)
      runner.run()
      await vi.advanceTimersByTimeAsync(171_998)
      runner.run()
      expect(task).toHaveBeenCalledTimes(1)

      // 5x the 35s duration → next tick-driven run only after 175s idle.
      await vi.advanceTimersByTimeAsync(2)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })

    it('caps the backoff at maxIntervalMs', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      await completeRunOfDuration(runner, calls, 120_000)
      expect(task).toHaveBeenCalledTimes(1)

      // 5 x 120s = 600s uncapped; the cap holds the gap to 300s.
      runner.run()
      await vi.advanceTimersByTimeAsync(299_999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })

    it('keeps minIntervalMs as the gap for fast tasks', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      await completeRunOfDuration(runner, calls, 100)
      expect(task).toHaveBeenCalledTimes(1)

      // max(3000, 5 x 100ms) = 3000 → normal-repo cadence is unchanged.
      runner.run()
      await vi.advanceTimersByTimeAsync(2999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })

    it('lets change signals run after the short backoff instead of the tick backoff', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      await completeRunOfDuration(runner, calls, 35_000)
      expect(task).toHaveBeenCalledTimes(1)

      // A change signal waits 1 x 35s, not 5 x 35s.
      runner.run({ changeSignal: true })
      await vi.advanceTimersByTimeAsync(34_999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })

    it('pulls an already-scheduled tick run earlier when a change signal arrives', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      await completeRunOfDuration(runner, calls, 35_000)
      runner.run() // tick scheduled for +175s
      await vi.advanceTimersByTimeAsync(10_000)

      runner.run({ changeSignal: true }) // reschedules for end + 35s
      await vi.advanceTimersByTimeAsync(24_999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      // The superseded tick timer must not fire an extra run later.
      calls[1]?.resolve()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(task).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('does not let a later tick delay a scheduled change-signal run', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      await completeRunOfDuration(runner, calls, 35_000)
      runner.run({ changeSignal: true }) // scheduled for +35s
      await vi.advanceTimersByTimeAsync(10_000)
      runner.run() // tick must not push the schedule to +175s

      await vi.advanceTimersByTimeAsync(24_999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })

    it('keeps change-signal pacing for a signal that arrived mid-run', async () => {
      vi.useFakeTimers()
      const { runner, task, calls } = makeSlowRunner()

      runner.run()
      await vi.advanceTimersByTimeAsync(20_000)
      runner.run({ changeSignal: true }) // during flight
      await vi.advanceTimersByTimeAsync(15_000)
      runner.run() // a later tick must not downgrade the pending signal
      calls[0]?.resolve()
      await flushMicrotasks()
      expect(task).toHaveBeenCalledTimes(1)

      // Trailing rerun waits 1 x 35s (signal), not 5 x 35s (tick).
      await vi.advanceTimersByTimeAsync(34_999)
      expect(task).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(2)

      calls[1]?.resolve()
      await flushMicrotasks()
      vi.useRealTimers()
    })
  })

  it('cancels scheduled deferred run on dispose', async () => {
    vi.useFakeTimers()
    const calls: ReturnType<typeof deferred>[] = []
    const task = vi.fn(() => {
      const call = deferred()
      calls.push(call)
      return call.promise
    })
    const runner = createCoalescedPollRunner(task, { minIntervalMs: 1000 })

    runner.run()
    runner.run()
    calls[0]?.resolve()
    await flushMicrotasks()

    runner.dispose()

    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})
