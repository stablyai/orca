import type { PreloadApi } from '../../../../preload/api-types'
import { enqueueRuntimeSubscription } from '../../../../shared/runtime-rpc-subscription-queue'
import { isTimedPRRead } from '../../../../shared/runtime-rpc-call-queue'
import type { WebRuntimeSubscriptionRegistration } from './web-runtime-crew-subscription'
import { assertEnvironmentPairing, pinnedWebSubscriptionOptions } from './web-runtime-calls'
import {
  resolveEnvironment,
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  manuallyDisconnectedResponse,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse
} from './web-runtime-session'

export function createWebRuntimeEnvironmentSubscriber(
  pendingSubscriptions: Map<string, WebRuntimeSubscriptionRegistration>
): PreloadApi['runtimeEnvironments']['subscribe'] {
  return async (
    {
      selector,
      method,
      params,
      timeoutMs,
      subscriptionId,
      expectedEnvironmentPairingRevision,
      expectedEnvironmentRuntimeId
    },
    callbacks
  ) => {
    const environment = resolveEnvironment(selector)
    assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
    const client = getClientForEnvironment(environment)
    const controller = new AbortController()
    if (subscriptionId) {
      if (pendingSubscriptions.has(subscriptionId)) {
        throw new Error('Subscription id already exists')
      }
      pendingSubscriptions.set(subscriptionId, { controller })
    }
    let subscription
    try {
      subscription = await enqueueRuntimeSubscription(
        runtimeCallQueuePool,
        environment.id,
        method,
        params,
        (complete) => {
          assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
          if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
            throw new Error('runtime_manually_disconnected')
          }
          return client.subscribe(
            method,
            params,
            {
              ...callbacks,
              onError: (error) => {
                complete()
                callbacks.onError?.(error)
              },
              onClose: () => {
                complete()
                callbacks.onClose?.()
              },
              onResponse: (response) => {
                complete()
                try {
                  assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
                } catch (error) {
                  callbacks.onError?.({
                    code: 'runtime_environment_changed',
                    message: String(error)
                  })
                  callbacks.onClose?.()
                  controller.abort()
                  return
                }
                const result = manuallyDisconnectedEnvironmentIds.has(environment.id)
                  ? manuallyDisconnectedResponse(environment)
                  : response
                updateEnvironmentFromResponse(environment, result)
                callbacks.onResponse(result)
              }
            },
            {
              timeoutMs,
              signal: controller.signal,
              ...pinnedWebSubscriptionOptions(
                selector,
                expectedEnvironmentPairingRevision,
                expectedEnvironmentRuntimeId
              )
            }
          )
        },
        (handle) => handle.unsubscribe(),
        controller.signal
      )
    } finally {
      if (subscriptionId && pendingSubscriptions.get(subscriptionId)?.controller === controller) {
        pendingSubscriptions.delete(subscriptionId)
      }
    }
    if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
      subscription.unsubscribe()
      throw new Error('runtime_manually_disconnected')
    }
    return isTimedPRRead(method, params)
      ? { ...subscription, unsubscribe: () => controller.abort() }
      : subscription
  }
}
