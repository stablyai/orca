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
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
    const fresh = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)

    oldRead.resolve('old')
    await expect(Promise.all([first, joined])).resolves.toEqual(['old', 'old'])
    const freshJoin = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, freshJoin])).resolves.toEqual(['fresh', 'fresh'])
    expect(vi.getTimerCount()).toBe(0)
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
    expect(vi.getTimerCount()).toBe(1)

    oldRead.reject(new Error('old read aborted'))
    await Promise.resolve()
    const joined = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['fresh', 'fresh'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)('clears the expiry timer after %s', async (outcome) => {
    const owner = new GitStatusReadLeaseOwner<string>(128, 30_000)
    const pending = deferred<string>()
    const read = owner.lease('diff', undefined, () => pending.promise)
    expect(vi.getTimerCount()).toBe(1)
    if (outcome === 'success') {
      pending.resolve('result')
      await expect(read).resolves.toBe('result')
    } else {
      const error = new Error('read failed')
      const rejected = expect(read).rejects.toBe(error)
      pending.reject(error)
      await rejected
    }
    expect(vi.getTimerCount()).toBe(0)
    await expect(owner.lease('diff', undefined, async () => 'retry')).resolves.toBe('retry')
    expect(vi.getTimerCount()).toBe(0)
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
    expect(vi.getTimerCount()).toBe(0)
    expect(signals[0]?.aborted).toBe(false)
    const fresh = owner.lease('diff', undefined, load)
    await vi.advanceTimersByTimeAsync(29_900)
    oldRead.resolve('old')
    await expect(old).resolves.toBe('old')
    const joined = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    freshRead.resolve('fresh')
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['fresh', 'fresh'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer only when the last pending caller cancels', async () => {
    const owner = new GitStatusReadLeaseOwner<string>(128, 30_000)
    const pending = deferred<string>()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return pending.promise
    })
    const first = owner.lease('diff', firstController.signal, load)
    const second = owner.lease('diff', secondController.signal, load)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    firstController.abort()
    await firstRejected
    expect(vi.getTimerCount()).toBe(1)
    expect(signals[0]?.aborted).toBe(false)
    secondController.abort()
    await secondRejected
    expect(vi.getTimerCount()).toBe(0)
    expect(signals[0]?.aborted).toBe(true)
    pending.reject(new Error('all callers cancelled'))
    await Promise.resolve()
    await expect(owner.lease('diff', undefined, async () => 'retry')).resolves.toBe('retry')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retain overflow reads or allocate expiry timers for them', async () => {
    const owner = new GitStatusReadLeaseOwner<string>(1, 30_000)
    const retainedRead = deferred<string>()
    const overflowRead = deferred<string>()
    const retained = owner.lease('retained', undefined, () => retainedRead.promise)
    const overflowLoad = vi.fn(() => overflowRead.promise)
    const first = owner.lease('overflow', undefined, overflowLoad)
    const second = owner.lease('overflow', undefined, overflowLoad)
    expect(overflowLoad).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    overflowRead.resolve('overflow')
    await expect(Promise.all([first, second])).resolves.toEqual(['overflow', 'overflow'])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(0)
    retainedRead.resolve('retained')
    await expect(retained).resolves.toBe('retained')
  })

  it('leaves expiry disabled for native owners that use the default constructor', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const first = owner.lease('diff', undefined, load)
    await vi.advanceTimersByTimeAsync(120_000)
    const second = owner.lease('diff', undefined, load)
    expect(load).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve('result')
    await expect(Promise.all([first, second])).resolves.toEqual(['result', 'result'])
  })
})
