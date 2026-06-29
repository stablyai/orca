import { describe, expect, it, vi } from 'vitest'
import { createCoalescedPollRunner } from './coalesced-poll-runner'

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
