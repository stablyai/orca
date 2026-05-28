import { describe, expect, it } from 'vitest'
import { createCombinedDiffLoadScheduler } from './combined-diff-load-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('combined diff load scheduler', () => {
  it('defaults to serial section loads', async () => {
    const blockers = [deferred(), deferred()]
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
        await blockers[index - 1]!.promise
      }
    })

    scheduler.request(1)
    scheduler.request(2)
    expect(started).toEqual([1])

    blockers[0]!.resolve()
    await flushMicrotasks()
    expect(started).toEqual([1, 2])

    blockers[1]!.resolve()
    await flushMicrotasks()
  })

  it('limits concurrent section loads', async () => {
    const blockers = [deferred(), deferred(), deferred()]
    const started: number[] = []
    let active = 0
    let maxActive = 0
    const scheduler = createCombinedDiffLoadScheduler({
      maxConcurrent: 2,
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
        active += 1
        maxActive = Math.max(maxActive, active)
        await blockers[started.length - 1]!.promise
        active -= 1
      }
    })

    scheduler.request(1)
    scheduler.request(2)
    scheduler.request(3)
    expect(started).toEqual([1, 2])

    blockers[0]!.resolve()
    await flushMicrotasks()
    expect(started).toEqual([1, 2, 3])
    expect(maxActive).toBe(2)

    blockers[1]!.resolve()
    blockers[2]!.resolve()
    await flushMicrotasks()
  })

  it('continues loading later sections when the first visible section is slow', async () => {
    const slow = deferred()
    const fast = deferred()
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      maxConcurrent: 2,
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
        if (index === 1) {
          await slow.promise
        }
        if (index === 2) {
          await fast.promise
        }
      }
    })

    scheduler.request(1)
    scheduler.request(2)
    scheduler.request(3)

    expect(started).toEqual([1, 2])
    fast.resolve()
    await flushMicrotasks()
    expect(started).toEqual([1, 2, 3])

    slow.resolve()
    await flushMicrotasks()
  })

  it('dedupes repeated visibility notifications', async () => {
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
      }
    })

    scheduler.request(4)
    scheduler.request(4)
    await flushMicrotasks()

    expect(started).toEqual([4])
  })

  it('allows a section to be requested again after a settled load', async () => {
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
      }
    })

    scheduler.request(4)
    await flushMicrotasks()
    scheduler.request(4)
    await flushMicrotasks()

    expect(started).toEqual([4, 4])
  })

  it('drops stale pending work after reset', async () => {
    const blocker = deferred()
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      maxConcurrent: 1,
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
        if (index === 1) {
          await blocker.promise
        }
      }
    })

    scheduler.request(1)
    scheduler.request(2)
    scheduler.reset()
    scheduler.request(3)
    blocker.resolve()
    await flushMicrotasks()

    expect(started).toEqual([1, 3])
  })

  it('revives after dispose when reset for a StrictMode remount', async () => {
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
      }
    })

    scheduler.dispose()
    scheduler.request(1)
    scheduler.reset()
    scheduler.request(2)
    await flushMicrotasks()

    expect(started).toEqual([2])
  })
})
