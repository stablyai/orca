import { describe, expect, it, vi } from 'vitest'
import { createCoalescingKeyedRunner } from './coalescing-keyed-runner'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createCoalescingKeyedRunner', () => {
  it('runs a lone call once and returns its result', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const work = vi.fn(async () => 'done')

    await expect(run('repo', 'target', work)).resolves.toBe('done')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('folds a burst that arrives mid-run into one trailing run that every burst caller shares', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const firstWork = vi.fn(() => first.promise)
    const leading = run('repo', 'target', firstWork)
    await vi.waitFor(() => expect(firstWork).toHaveBeenCalledTimes(1))

    const burstWork = Array.from({ length: 5 }, (_, index) =>
      vi.fn(async () => `trailing-${index}`)
    )
    const burst = burstWork.map((work) => run('repo', 'target', work))
    expect(burstWork.every((work) => work.mock.calls.length === 0)).toBe(true)

    first.resolve('leading')
    await expect(leading).resolves.toBe('leading')
    // The trailing run uses the latest caller's work, and every burst caller gets its result.
    await expect(Promise.all(burst)).resolves.toEqual(Array(5).fill('trailing-4'))
    expect(burstWork.slice(0, 4).every((work) => work.mock.calls.length === 0)).toBe(true)
    expect(burstWork[4]).toHaveBeenCalledTimes(1)
  })

  it('queues a caller with a different share key behind the run in flight, never beside it', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    let active = 0
    let maxActive = 0
    const tracked = (work: () => Promise<string>) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await work()
      } finally {
        active -= 1
      }
    }
    const leadingWork = tracked(() => first.promise)
    const leading = run('repo', 'origin', leadingWork)
    const other = vi.fn(async () => 'upstream result')
    const queued = run('repo', 'upstream', tracked(other))
    await Promise.resolve()
    expect(other).not.toHaveBeenCalled()

    first.resolve('origin result')
    await expect(Promise.all([leading, queued])).resolves.toEqual([
      'origin result',
      'upstream result'
    ])
    expect(maxActive).toBe(1)
  })

  it('answers every caller from a run of its own share key, in arrival order', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const order: string[] = []
    const work = (shareKey: string, caller: number) => async () => {
      order.push(`${shareKey}:${caller}`)
      return `${shareKey}:${caller}`
    }
    const leading = run('repo', 'origin', () => first.promise)
    const callers = [
      run('repo', 'upstream', work('upstream', 1)),
      run('repo', 'origin', work('origin', 2)),
      run('repo', 'upstream', work('upstream', 3))
    ]

    first.resolve('origin:0')
    await expect(leading).resolves.toBe('origin:0')
    // Each queued run uses its latest joiner's work; the runs start in the order they were queued.
    await expect(Promise.all(callers)).resolves.toEqual(['upstream:3', 'origin:2', 'upstream:3'])
    expect(order).toEqual(['upstream:3', 'origin:2'])
  })

  it('bounds a mixed burst to one run per distinct share key beyond the one in flight', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const work = vi.fn(async () => 'done')
    const leading = run('repo', 'origin', () => first.promise)
    const burst = Array.from({ length: 12 }, (_, index) =>
      run('repo', ['origin', 'upstream', 'fork'][index % 3] ?? 'origin', work)
    )

    first.resolve('done')
    await Promise.all([leading, ...burst])
    expect(work).toHaveBeenCalledTimes(3)
  })

  it('starts the trailing run even when the run in flight rejects', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const leading = run('repo', 'target', () => first.promise)
    const trailing = run('repo', 'target', async () => 'after failure')

    first.reject(new Error('boom'))
    await expect(leading).rejects.toThrow('boom')
    await expect(trailing).resolves.toBe('after failure')
  })

  it('does not let a rejected run block the next call', async () => {
    const run = createCoalescingKeyedRunner<string>()

    const failing = async (): Promise<string> => {
      throw new Error('boom')
    }
    await expect(run('repo', 'target', failing)).rejects.toThrow('boom')
    await expect(run('repo', 'target', async () => 'next')).resolves.toBe('next')
  })

  it('runs different keys concurrently', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const held = deferred<string>()
    const heldResult = run('repo-a', 'target', () => held.promise)
    const other = vi.fn(async () => 'other')

    await expect(run('repo-b', 'target', other)).resolves.toBe('other')
    expect(other).toHaveBeenCalledTimes(1)
    held.resolve('held')
    await expect(heldResult).resolves.toBe('held')
  })

  it('starts fresh once a key has settled, instead of joining a finished run', async () => {
    const run = createCoalescingKeyedRunner<number>()
    let runs = 0
    const work = async () => ++runs

    await expect(run('repo', 'target', work)).resolves.toBe(1)
    await expect(run('repo', 'target', work)).resolves.toBe(2)

    const leading = run('repo', 'target', work)
    const trailing = run('repo', 'target', work)
    await expect(Promise.all([leading, trailing])).resolves.toEqual([3, 4])
    await expect(run('repo', 'target', work)).resolves.toBe(5)
  })
})
