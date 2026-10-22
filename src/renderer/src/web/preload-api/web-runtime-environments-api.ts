import { verifyAndAddWebRuntimeEnvironment } from './web-runtime-pairing-verification'
const pendingSubscriptions = new Map<string, AbortController>()
import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { parseWebPairingInput } from '../web-pairing'
import {
  createStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'
import { assertEnvironmentPairing, callEnvironmentEnvelope } from './web-runtime-calls'
import {
  closeActiveRuntimeClients,
  subscribeWebRuntimeStatus,
  readWebRuntimeStatusSnapshots,
  observeWebRuntimeStatus,
  disconnectActiveRuntimeEnvironment,
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  removeActiveRuntimeEnvironment,
  requireActiveEnvironmentOrNull,
  resolveEnvironment,
  webRuntimeState,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse,
  manuallyDisconnectedResponse
} from './web-runtime-session'

export function createRuntimeEnvironmentsApi(): NonNullable<
  Partial<PreloadApi>['runtimeEnvironments']
> {
  return {
    getEdgeAuthStatus: undefined,
    saveEdgeAuth: undefined,
    clearEdgeAuth: undefined,
    onStatusChanged: subscribeWebRuntimeStatus,
    getStatusSnapshots: async () => readWebRuntimeStatusSnapshots(),
    list: async () => {
      const environment = requireActiveEnvironmentOrNull()
      return environment ? [redactStoredWebRuntimeEnvironment(environment)] : []
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      const offer = parseWebPairingInput(pairingCode)
      if (!offer) {
        throw new Error('Invalid Orca pairing code.')
      }
      const previousEnvironment = webRuntimeState.activeEnvironment
      closeActiveRuntimeClients()
      webRuntimeState.activeEnvironment = createStoredWebRuntimeEnvironment({
        name,
        offer,
        previousEnvironment
      })
      manuallyDisconnectedEnvironmentIds.clear()
      saveStoredWebRuntimeEnvironment(webRuntimeState.activeEnvironment)
      return { environment: redactStoredWebRuntimeEnvironment(webRuntimeState.activeEnvironment) }
    },
    verifyAndAddFromPairingCode: verifyAndAddWebRuntimeEnvironment,
    // Why: the browser keeps a single paired server; pairing it again replaces that one.
    repairFromPairingCode: async () => ({
      ok: false,
      kind: 'environment-save-failed',
      message: translate(
        'auto.web.webPreloadApi.remotePairingRepairUnavailable',
        'Re-pairing is not available in the browser. Pair this browser with the server again.'
      )
    }),
    resolve: async ({ selector }) =>
      redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    remove: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        removeActiveRuntimeEnvironment()
      }
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    disconnect: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        manuallyDisconnectedEnvironmentIds.add(environment.id)
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
    },
    connect: ({ selector, timeoutMs }) => {
      const environment = resolveEnvironment(selector)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      closeActiveRuntimeClients()
      return callEnvironmentEnvelope<RuntimeStatus>(
        environment.id,
        'status.get',
        undefined,
        timeoutMs
      )
    },
    getStatus: ({ selector, timeoutMs, observeOnly }) =>
      observeOnly
        ? observeWebRuntimeStatus(selector, timeoutMs)
        : callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    retryControlConnection: () => Promise.resolve(),
    prepareBrowserClientHostPlacement: async () => ({ kind: 'server' }),
    call: ({
      selector,
      method,
      params,
      timeoutMs,
      expectedEnvironmentPairingRevision,
      expectedEnvironmentRuntimeId
    }) =>
      callEnvironmentEnvelope(
        selector,
        method,
        params,
        timeoutMs,
        expectedEnvironmentPairingRevision,
        expectedEnvironmentRuntimeId
      ),
    cancelSubscription: async ({ subscriptionId }) => {
      pendingSubscriptions.get(subscriptionId)?.abort()
    },
    subscribe: async (
      { selector, method, params, timeoutMs, subscriptionId, expectedEnvironmentPairingRevision },
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
        pendingSubscriptions.set(subscriptionId, controller)
      }
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
  }
}
