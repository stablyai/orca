import { afterEach, describe, expect, it, vi } from 'vitest'
import { withRuntimeRpcDeadline } from './runtime-rpc-deadline'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('withRuntimeRpcDeadline', () => {
  it('returns the original promise when the caller set no deadline or signal', () => {
    const call = Promise.resolve('value')
    expect(withRuntimeRpcDeadline(call, { method: 'files.read' })).toBe(call)
  })

  it('rejects a call that outlives timeoutMs, naming the method', async () => {
    vi.useFakeTimers()
    const call = deferred<string>()
    const bounded = withRuntimeRpcDeadline(call.promise, { method: 'files.read', timeoutMs: 50 })
    const rejection = expect(bounded).rejects.toThrow(
      'Runtime request timed out before files.read completed'
    )
    await vi.advanceTimersByTimeAsync(50)
    await rejection
  })

  it('resolves a call that finishes within timeoutMs and clears the deadline', async () => {
    vi.useFakeTimers()
    const call = deferred<string>()
    const bounded = withRuntimeRpcDeadline(call.promise, { method: 'files.read', timeoutMs: 50 })
    call.resolve('value')
    await expect(bounded).resolves.toBe('value')
    // A settled call must not leave a timer that would later reject.
    await vi.advanceTimersByTimeAsync(100)
    await expect(bounded).resolves.toBe('value')
  })

  it('rejects with the runtime abort error when the signal aborts', async () => {
    const controller = new AbortController()
    const call = deferred<string>()
    const bounded = withRuntimeRpcDeadline(call.promise, {
      method: 'files.read',
      signal: controller.signal
    })
    controller.abort()
    await expect(bounded).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const call = deferred<string>()
    await expect(
      withRuntimeRpcDeadline(call.promise, { method: 'files.read', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes through a rejection that arrives before the deadline', async () => {
    const call = deferred<string>()
    const bounded = withRuntimeRpcDeadline(call.promise, { method: 'files.read', timeoutMs: 50 })
    call.reject(new Error('host refused'))
    await expect(bounded).rejects.toThrow('host refused')
  })
})
