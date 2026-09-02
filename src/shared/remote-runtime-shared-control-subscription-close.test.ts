import { describe, expect, it, vi } from 'vitest'
import { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'
import {
  closeSharedControlConnectionSubscription,
  sendRetiredSharedControlCleanupRequest
} from './remote-runtime-shared-control-subscription-close'
import { createSharedControlSubscription } from './remote-runtime-shared-control-subscriptions'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

describe('shared-control subscription retirement', () => {
  it('retires a closed subscription and its cleanup request', () => {
    const subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
    const subscription = createSharedControlSubscription({
      requestId: 'request-1',
      method: 'runtime.clientEvents.subscribe',
      params: null,
      retainedParamsBytes: 0,
      callbacks: { onResponse: vi.fn(), onError: vi.fn() }
    })
    subscription.sent = true
    subscription.remoteSubscriptionId = 'subscription-1'
    subscriptions.set(subscription.requestId, subscription)
    const retiredRequestIds = new SharedControlRetiredRequestIds()
    let cleanupRequestId = ''

    closeSharedControlConnectionSubscription({
      subscriptions,
      retiredRequestIds,
      requestId: subscription.requestId,
      deviceToken: 'device-token',
      send: (payload) => {
        cleanupRequestId = (payload as { id: string }).id
        return true
      }
    })

    expect(subscriptions.size).toBe(0)
    expect(retiredRequestIds.has(subscription.requestId)).toBe(true)
    expect(retiredRequestIds.has(cleanupRequestId)).toBe(true)
  })

  it('does not retire an unsent cleanup request', () => {
    const retiredRequestIds = new SharedControlRetiredRequestIds()
    let cleanupRequestId = ''

    sendRetiredSharedControlCleanupRequest({
      retiredRequestIds,
      deviceToken: 'device-token',
      method: 'runtime.clientEvents.unsubscribe',
      params: null,
      send: (payload) => {
        cleanupRequestId = (payload as { id: string }).id
        return false
      }
    })

    expect(retiredRequestIds.has(cleanupRequestId)).toBe(false)
  })
})
