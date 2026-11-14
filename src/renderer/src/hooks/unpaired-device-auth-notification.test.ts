import { describe, expect, it, vi } from 'vitest'
import { subscribeToUnpairedDeviceAuthNotification } from './unpaired-device-auth-notification'

describe('subscribeToUnpairedDeviceAuthNotification', () => {
  it('finishes an in-flight one-shot claim across StrictMode cleanup', async () => {
    const pendingState: { resolve?: (pending: boolean) => void } = {}
    const onNotification = vi.fn()
    const unsubscribe = subscribeToUnpairedDeviceAuthNotification(
      {
        consumePendingUnpairedDeviceAuthFailure: () =>
          new Promise((resolve) => {
            pendingState.resolve = resolve
          })
      },
      onNotification
    )

    unsubscribe()
    pendingState.resolve?.(true)
    await Promise.resolve()

    expect(onNotification).toHaveBeenCalledOnce()
  })
})
