import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitStatusReadLeaseOwner } from './git-status-read-lease-owner'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not initialized')
  }
  let reject: (error: unknown) => void = () => {
    throw new Error('Deferred promise is not initialized')
  }
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Git read lease expiry', () => {
  it('joins before expiry, then retries without aborting existing callers', async () => {
    const owner = new GitStatusReadLeaseOwner<string>(128, 30_000)
    const oldRead = deferred<string>()
    const freshRead = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? oldRead.promise : freshRead.promise
    })
    const first = owner.lease('diff', undefined, load)
    await vi.advanceTimersByTimeAsync(29_999)
    const joined = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)
    const fresh = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)

    oldRead.resolve('old')
    await expect(Promise.all([first, joined])).resolves.toEqual(['old', 'old'])
    const freshJoin = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, freshJoin])).resolves.toEqual(['fresh', 'fresh'])
  })

  it('keeps cancellation ownership separate after an expired read is replaced', async () => {
    const owner = new GitStatusReadLeaseOwner<string>(128, 30_000)
    const oldRead = deferred<string>()
    const freshRead = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? oldRead.promise : freshRead.promise
    })
    const controller = new AbortController()
    const old = owner.lease('diff', controller.signal, load)
    await vi.advanceTimersByTimeAsync(30_000)
    const fresh = owner.lease('diff', undefined, load)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    oldRead.reject(new Error('old read aborted'))
    await Promise.resolve()
    const joined = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['fresh', 'fresh'])
  })

  it('invalidates the old timer without aborting its leases or expiring the replacement', async () => {
    const owner = new GitStatusReadLeaseOwner<string>(128, 30_000)
    const oldRead = deferred<string>()
    const freshRead = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? oldRead.promise : freshRead.promise
    })
    const old = owner.lease('diff', undefined, load)
    await vi.advanceTimersByTimeAsync(100)
    owner.invalidate()
    expect(signals[0]?.aborted).toBe(false)
    const fresh = owner.lease('diff', undefined, load)
    await vi.advanceTimersByTimeAsync(29_900)
    oldRead.resolve('old')
    await expect(old).resolves.toBe('old')
    const joined = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['fresh', 'fresh'])
  })
})
