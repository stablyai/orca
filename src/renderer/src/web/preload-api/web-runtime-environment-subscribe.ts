import type { PreloadApi } from '../../../../preload/api-types'
import { assertEnvironmentPairing } from './web-runtime-calls'
import {
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  manuallyDisconnectedResponse,
  resolveEnvironment,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse
} from './web-runtime-session'

type RuntimeEnvironmentsApi = NonNullable<PreloadApi['runtimeEnvironments']>

const pendingSubscriptions = new Map<string, AbortController>()

export const cancelWebRuntimeEnvironmentSubscription: RuntimeEnvironmentsApi['cancelSubscription'] =
  async ({ subscriptionId }) => {
    pendingSubscriptions.get(subscriptionId)?.abort()
  }

export const subscribeWebRuntimeEnvironment: RuntimeEnvironmentsApi['subscribe'] = async (
  {
    selector,
    method,
    params,
    timeoutMs,
    subscriptionId,
    expectedEnvironmentPairingRevision,
    dispatchObservation,
    observeDispatch
  },
  { onSent, ...callbacks }
) => {
  const environment = resolveEnvironment(selector)
  assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
  const client = getClientForEnvironment(environment)
  const controller = new AbortController()
  if (subscriptionId) {
    if (pendingSubscriptions.has(subscriptionId)) {
      throw new Error('Subscription id already exists')
    }
    pendingSubscriptions.set(subscriptionId, controller)
  }
  // As the desktop's main process does: a request still queued at its send-by time is dropped
  // unsent, so the caller's response bound starts only at the actual send.
  const unsent =
    dispatchObservation &&
    setTimeout(() => controller.abort(), Math.max(0, dispatchObservation.expiresAt - Date.now()))
  let subscription
  try {
    subscription = await runtimeCallQueuePool.enqueue(
      environment.id,
      method,
      () => {
        assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
        if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
          throw new Error('runtime_manually_disconnected')
        }
        return client.subscribe(
          method,
          params,
          {
            ...callbacks,
            // As on the desktop, only a caller that asked to observe the send hears it.
            ...(observeDispatch ? { onSent } : {}),
            onResponse: (response) => {
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
          { timeoutMs, signal: controller.signal }
        )
      },
      0,
      controller.signal
    )
  } finally {
    // Settled: the frame was sent, or the request failed.
    clearTimeout(unsent)
    if (subscriptionId && pendingSubscriptions.get(subscriptionId) === controller) {
      pendingSubscriptions.delete(subscriptionId)
    }
  }
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    subscription.unsubscribe()
    throw new Error('runtime_manually_disconnected')
  }
  return subscription
}
