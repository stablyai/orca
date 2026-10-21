import { expect, it, vi } from 'vitest'
import { startSharedControlSubscription } from './remote-runtime-shared-control-subscription-start'
import { closeSharedControlConnectionSubscription } from './remote-runtime-shared-control-subscription-close'
import { handleSharedControlLogicalResponse } from './remote-runtime-shared-control-subscriptions'
import { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

it.each([true, false])(
  'cleans up replayed setup aborted with host id known=%s',
  async (idKnown) => {
    const subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
    const controller = new AbortController()
    const send = vi.fn((_payload: unknown) => true)
    const onResponse = vi.fn()
    const retiredRequestIds = new SharedControlRetiredRequestIds()
    await expect(
      startSharedControlSubscription({
        subscriptions,
        deviceToken: 'token',
        method: 'accounts.subscribe',
        params: null,
        callbacks: { onResponse, onError: vi.fn() },
        signal: controller.signal,
        ensureReady: async () => {
          for (const subscription of subscriptions.values()) {
            subscription.sent = true
            subscription.remoteSubscriptionId = idKnown ? 'host-subscription' : null
          }
          controller.abort()
        },
        sendSubscription: vi.fn(),
        closeSubscription: (requestId) =>
          closeSharedControlConnectionSubscription({
            subscriptions,
            retiredRequestIds,
            requestId,
            deviceToken: 'token',
            send
          })
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    if (!idKnown) {
      expect(subscriptions.size).toBe(1)
      expect(send).not.toHaveBeenCalled()
      for (const subscription of subscriptions.values()) {
        handleSharedControlLogicalResponse({
          subscriptions,
          subscription,
          response: {
            id: subscription.requestId,
            ok: true,
            result: { subscriptionId: 'host-subscription' },
            _meta: { runtimeId: 'host' }
          },
          request: (method, params) => send({ method, params })
        })
      }
    }
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'accounts.unsubscribe',
        params: { subscriptionId: 'host-subscription' }
      })
    )
    expect(subscriptions.size).toBe(0)
    expect(onResponse).not.toHaveBeenCalled()
  }
)
