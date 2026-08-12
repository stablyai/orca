import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhysicalExitTracker } from './physical-exit-tracker'

describe('PhysicalExitTracker', () => {
  afterEach(() => vi.useRealTimers())

  it('removes timed-out waiters while later retries can still observe exit', async () => {
    vi.useFakeTimers()
    const tracker = new PhysicalExitTracker()
    const first = tracker.waitForExit(10, () => new Error('first deadline'))
    const firstRejection = expect(first).rejects.toThrow('first deadline')

    await vi.advanceTimersByTimeAsync(10)
    await firstRejection

    const retry = tracker.waitForExit(10, () => new Error('retry deadline'))
    tracker.markExited()

    await expect(retry).resolves.toBeUndefined()
    await expect(tracker.exitedPromise).resolves.toBeUndefined()
  })

  it('settles every active waiter once and resolves later waits immediately', async () => {
    const tracker = new PhysicalExitTracker()
    const first = tracker.waitForExit(100, () => new Error('deadline'))
    const second = tracker.waitForExit(100, () => new Error('deadline'))

    tracker.markExited()
    tracker.markExited()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await expect(tracker.waitForExit(1, () => new Error('deadline'))).resolves.toBeUndefined()
  })
})
