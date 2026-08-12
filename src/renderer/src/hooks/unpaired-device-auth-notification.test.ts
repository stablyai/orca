import { describe, expect, it, vi } from 'vitest'
import { subscribeToUnpairedDeviceAuthNotification } from './unpaired-device-auth-notification'

describe('subscribeToUnpairedDeviceAuthNotification', () => {
  it('delivers a notification retained before the renderer subscribed', async () => {
    const onNotification = vi.fn()
    const unsubscribe = subscribeToUnpairedDeviceAuthNotification(
      {
        consumePendingUnpairedDeviceAuthFailure: vi.fn().mockResolvedValue(true),
        onUnpairedDeviceAuthFailure: vi.fn(() => vi.fn())
      },
      onNotification
    )

    await Promise.resolve()

    expect(onNotification).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('consumes concurrent mount and live signals only once', async () => {
    const onNotification = vi.fn()
    const listenerState: { liveListener?: () => void } = {}
    const consumePendingUnpairedDeviceAuthFailure = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    const unsubscribe = subscribeToUnpairedDeviceAuthNotification(
      {
        consumePendingUnpairedDeviceAuthFailure,
        onUnpairedDeviceAuthFailure: (listener) => {
          listenerState.liveListener = listener
          return vi.fn()
        }
      },
      onNotification
    )

    listenerState.liveListener?.()
    await Promise.resolve()

    expect(consumePendingUnpairedDeviceAuthFailure).toHaveBeenCalledTimes(2)
    expect(onNotification).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('keeps live delivery with an older preload that has no consume API', () => {
    const onNotification = vi.fn()
    const listenerState: { liveListener?: () => void } = {}
    const unsubscribe = subscribeToUnpairedDeviceAuthNotification(
      {
        onUnpairedDeviceAuthFailure: (listener) => {
          listenerState.liveListener = listener
          return vi.fn()
        }
      },
      onNotification
    )

    expect(onNotification).not.toHaveBeenCalled()
    listenerState.liveListener?.()
    expect(onNotification).toHaveBeenCalledOnce()
    unsubscribe()
  })

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
