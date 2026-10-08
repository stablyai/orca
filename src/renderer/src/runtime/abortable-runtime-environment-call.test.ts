// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('cancels setup using the preselected id and unsubscribes a late handle', async () => {
  let finishSetup: ((value: { unsubscribe: () => void }) => void) | undefined
  const subscribe = vi.fn(
    (_args: { subscriptionId?: string }) =>
      new Promise<{ unsubscribe: () => void }>((resolve) => {
        finishSetup = resolve
      })
  )
  const cancelSubscription = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe, cancelSubscription } } })
  const controller = new AbortController()
  const pending = callAbortableRuntimeEnvironment(
    'env',
    'files.search',
    {},
    15_000,
    controller.signal
  )
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const args = subscribe.mock.calls[0]?.[0]
  controller.abort()
  await rejection
  expect(cancelSubscription).toHaveBeenCalledWith({ subscriptionId: expect.any(String) })
  expect(cancelSubscription.mock.calls[0]?.[0].subscriptionId).toBe(args?.subscriptionId)
  const unsubscribe = vi.fn()
  finishSetup?.({ unsubscribe })
  await Promise.resolve()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('keeps the response deadline while setup is pending', async () => {
  vi.useFakeTimers()
  const subscribe = vi.fn(() => new Promise(() => {}))
  const cancelSubscription = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe, cancelSubscription } } })
  const pending = callAbortableRuntimeEnvironment(
    'env',
    'files.search',
    {},
    15_000,
    new AbortController().signal
  )
  const rejection = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(15_000)
  await rejection
  expect(cancelSubscription).toHaveBeenCalledOnce()
})
