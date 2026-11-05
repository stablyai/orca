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
  it('rerequest clears an in-flight queue slot before reloading', async () => {
    const blocker = deferred()
    const started: number[] = []
    const scheduler = createCombinedDiffLoadScheduler({
      maxConcurrent: 1,
      schedule: (callback) => callback(),
      loadSection: async (index) => {
        started.push(index)
        if (index === 4) {
          await blocker.promise
        }
      }
    })

    scheduler.request(4)
    scheduler.request(4)
    expect(started).toEqual([4])

    scheduler.rerequest(4)
    blocker.resolve()
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
