import { afterEach, describe, expect, it, vi } from 'vitest'
import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('callAbortableRuntimeEnvironment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels pending setup by id and unsubscribes a late handle', async () => {
    const subscription = deferred<{ unsubscribe: () => void; sendBinary: () => void }>()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_args: { subscriptionId?: string }, _callbacks: unknown) => subscription.promise
    )
    const cancelSubscription = vi.fn().mockResolvedValue({ unsubscribed: true })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { subscribe, cancelSubscription } }
    })
    const controller = new AbortController()
    const call = callAbortableRuntimeEnvironment(
      'environment-1',
      'files.search',
      { query: 'needle' },
      15_000,
      controller.signal
    )
    const rejection = expect(call).rejects.toMatchObject({ name: 'AbortError' })
    const subscriptionId = subscribe.mock.calls[0]?.[0].subscriptionId
    if (!subscriptionId) {
      throw new Error('Expected renderer-selected subscription id')
    }

    controller.abort()

    await rejection
    expect(cancelSubscription).toHaveBeenCalledWith({ subscriptionId })
    expect(unsubscribe).not.toHaveBeenCalled()

    subscription.resolve({ unsubscribe, sendBinary: vi.fn() })
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  })
})
