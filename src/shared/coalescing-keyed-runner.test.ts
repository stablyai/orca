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
    await expect(Promise.all(callers)).resolves.toEqual(['upstream:3', 'origin:2', 'upstream:3'])
    expect(order).toEqual(['upstream:3', 'origin:2'])
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

  it('runs different keys concurrently', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const held = deferred<string>()
    const heldResult = run('repo-a', 'target', () => held.promise)
    const other = vi.fn(async () => 'other')

    await expect(run('repo-b', 'target', other)).resolves.toBe('other')
    held.resolve('held')
    await expect(heldResult).resolves.toBe('held')
  })
})
