// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'
import { stubRuntimeEnvironmentBridge } from '../testing/runtime-environment-bridge-fixture'
beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('d0b695cc-c36b-4d6d-aa45-e62ce3457d19')
})
afterEach(() => {
  vi.restoreAllMocks()
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
  stubRuntimeEnvironmentBridge({ subscribe, cancelSubscription })
  const controller = new AbortController()
  const pending = callAbortableRuntimeEnvironment(
    'env',
    'files.search',
    {},
    15_000,
    controller.signal
  )
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(cancelSubscription).toHaveBeenCalledWith({
    subscriptionId: 'd0b695cc-c36b-4d6d-aa45-e62ce3457d19'
  })
  const unsubscribe = vi.fn()
  finishSetup?.({ unsubscribe })
  await Promise.resolve()
  expect(unsubscribe).toHaveBeenCalled()
})
