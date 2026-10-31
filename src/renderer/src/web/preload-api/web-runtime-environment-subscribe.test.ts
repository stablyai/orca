import { afterEach, expect, it, vi } from 'vitest'
import { subscribeWebRuntimeEnvironment } from './web-runtime-environment-subscribe'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  // A busy connection: the request waits in line until its signal ends the wait.
  enqueue: vi.fn(
    (_id: string, _method: string, _run: () => unknown, _priority: number, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
  )
}))
vi.mock('./web-runtime-calls', () => ({ assertEnvironmentPairing: () => undefined }))
vi.mock('./web-runtime-session', () => ({
  resolveEnvironment: () => ({ id: 'environment' }),
  getClientForEnvironment: () => ({ subscribe: mocks.subscribe }),
  manuallyDisconnectedEnvironmentIds: new Set(),
  manuallyDisconnectedResponse: vi.fn(),
  updateEnvironmentFromResponse: vi.fn(),
  runtimeCallQueuePool: { enqueue: mocks.enqueue }
}))

afterEach(() => vi.useRealTimers())

it('drops a request still queued at its send-by time, unsent, as the desktop does', async () => {
  vi.useFakeTimers()
  const onSent = vi.fn()
  const subscribing = subscribeWebRuntimeEnvironment(
    {
      subscriptionId: 'switch',
      selector: 'environment',
      method: 'agentSession.switchToChat',
      params: {},
      dispatchObservation: { expiresAt: Date.now() + 1_000, responseTimeoutMs: 105_000 }
    },
    { onResponse: vi.fn(), onSent }
  )
  const settled = expect(subscribing).rejects.toThrow('aborted')
  await vi.advanceTimersByTimeAsync(1_000)
  await settled
  expect(mocks.subscribe).not.toHaveBeenCalled()
  expect(onSent).not.toHaveBeenCalled()
})

it.each([true, false])(
  'tells the caller its request was sent only when it asked to observe the send=%s',
  async (observeDispatch) => {
    mocks.enqueue.mockImplementationOnce(async (_id, _method, run) => run())
    mocks.subscribe.mockImplementationOnce(async (_method, _params, callbacks) => {
      callbacks.onSent?.(1)
      return { unsubscribe: vi.fn() }
    })
    const onSent = vi.fn()
    await subscribeWebRuntimeEnvironment(
      { selector: 'environment', method: 'agentSession.switchToChat', params: {}, observeDispatch },
      { onResponse: vi.fn(), onSent }
    )
    expect(onSent).toHaveBeenCalledTimes(observeDispatch ? 1 : 0)
  }
)
