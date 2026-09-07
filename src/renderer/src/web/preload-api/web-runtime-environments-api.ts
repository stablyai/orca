import type { PreloadApi } from '../../../../preload/api-types'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { verifyRemotePairingRuntimeStatus } from '../../../../shared/remote-pairing-verification'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { parseWebPairingInput } from '../web-pairing'
import { WebRuntimeClient } from '../web-runtime-client'
import { isWebRuntimeUnauthorizedError } from '../web-runtime-client-error'
import {
  createStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'
import { translateHostAccessLinkError } from '@/lib/remote-pairing-copy'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import {
  closeActiveRuntimeClients,
  disconnectActiveRuntimeEnvironment,
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  removeActiveRuntimeEnvironment,
  requireActiveEnvironmentOrNull,
  resolveEnvironment,
  webRuntimeState
} from './web-runtime-session'

export function createRuntimeEnvironmentsApi(): NonNullable<
  Partial<PreloadApi>['runtimeEnvironments']
> {
  const native = window.orcaWorkspaceWindowNative?.runtimeEnvironments
  const configured = (selector: string): boolean => {
    if (!native) {
      return false
    }
    const local = requireActiveEnvironmentOrNull()
    return (
      selector !== 'active' &&
      selector !== local?.id &&
      selector !== local?.name &&
      !local?.compatibleEnvironmentIds?.includes(selector)
    )
  }
  return {
    list: async () => {
      const environment = requireActiveEnvironmentOrNull()
      return [
        ...(environment ? [redactStoredWebRuntimeEnvironment(environment)] : []),
        ...(native ? await native.list() : [])
      ]
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      if (native) {
        return native.addFromPairingCode({ name, pairingCode })
      }
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
    verifyAndAddFromPairingCode: async ({ name, pairingCode, allowLoopback }) => {
      if (native) {
        return native.verifyAndAddFromPairingCode({ name, pairingCode, allowLoopback })
      }
      const parsed = parseHostAccessLink(pairingCode)
      if (!parsed.ok) {
        return {
          ok: false,
          kind: 'access-link-invalid',
          message: translateHostAccessLinkError(parsed.kind)
        }
      }
      if (parsed.value.endpointKind === 'loopback' && !allowLoopback) {
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.loopbackPairingBlocked',
            'This access link points back to this device.'
          )
        }
      }
      let client: WebRuntimeClient | null = null
      let runtimeStatus: RuntimeStatus
      try {
        client = new WebRuntimeClient(parsed.value.pairing)
        const response = (await client.call('status.get', undefined, {
          timeoutMs: 15_000
        })) as RuntimeRpcResponse<RuntimeStatus>
        if (!response.ok) {
          return {
            ok: false,
            kind: 'connection-interrupted',
            message: response.error.message
          }
        }
        const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
        if (!statusVerification.ok) {
          return statusVerification
        }
        runtimeStatus = statusVerification.runtimeStatus
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid public key')) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: translate(
              'auto.web.webPreloadApi.remotePairingInvalidDetails',
              'This access link contains invalid connection details.'
            )
          }
        }
        if (
          isWebRuntimeUnauthorizedError(error) ||
          (error instanceof Error && error.message.startsWith('Unauthorized.'))
        ) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: error.message
          }
        }
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.remotePairingUnreachable',
            'Cannot reach Orca at {{endpoint}}.',
            { endpoint: parsed.value.displayEndpoint }
          )
        }
      } finally {
        client?.close()
      }
      const usesSshTunnel = parsed.value.endpointKind === 'loopback' && allowLoopback === true
      const nextEnvironment = {
        ...createStoredWebRuntimeEnvironment({
          name,
          offer: parsed.value.pairing,
          previousEnvironment: webRuntimeState.activeEnvironment,
          ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
        }),
        ...(runtimeStatus.pairedDeviceId ? { pairedDeviceId: runtimeStatus.pairedDeviceId } : {})
      }
      // Why: a browser storage failure must leave the currently active host usable.
      try {
        saveStoredWebRuntimeEnvironment(nextEnvironment)
      } catch {
        return {
          ok: false,
          kind: 'environment-save-failed',
          message: translate(
            'auto.web.webPreloadApi.remotePairingSaveFailed',
            'Orca verified the host but could not save it. Check browser storage and try again.'
          )
        }
      }
      manuallyDisconnectedEnvironmentIds.clear()
      closeActiveRuntimeClients()
      webRuntimeState.activeEnvironment = nextEnvironment
      return {
        ok: true,
        environment: redactStoredWebRuntimeEnvironment(nextEnvironment),
        runtimeStatus
      }
    },
    resolve: async ({ selector }) =>
      configured(selector)
        ? native!.resolve({ selector })
        : redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    remove: async ({ selector }) => {
      if (configured(selector)) {
        return native!.remove({ selector })
      }
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        removeActiveRuntimeEnvironment()
      }
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    disconnect: async ({ selector }) => {
      if (configured(selector)) {
        return native!.disconnect({ selector })
      }
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        manuallyDisconnectedEnvironmentIds.add(environment.id)
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
    },
    connect: ({ selector, timeoutMs }) => {
      if (configured(selector)) {
        return native!.connect({ selector, timeoutMs })
      }
      const environment = resolveEnvironment(selector)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return callEnvironmentEnvelope<RuntimeStatus>(
        environment.id,
        'status.get',
        undefined,
        timeoutMs
      )
    },
    getStatus: ({ selector, timeoutMs }) =>
      configured(selector)
        ? native!.getStatus({ selector, timeoutMs })
        : callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    retryControlConnection: () => Promise.resolve(),
    prepareBrowserClientHostPlacement: async () => ({ kind: 'server' }),
    call: async (args) => {
      const { selector, method, params, timeoutMs } = args
      if (method.startsWith('browser.') && window.orcaWorkspaceWindowNative) {
        const environment = configured(selector)
          ? await native!.resolve({ selector })
          : resolveEnvironment(selector)
        const response = await window.orcaWorkspaceWindowNative.browserInput({
          runtimeId: environment.runtimeId,
          ...(configured(selector)
            ? {
                environmentId: environment.id,
                expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
              }
            : {}),
          method,
          params
        })
        if (response) {
          return response
        }
      }
      if (configured(selector)) {
        return native!.call(args)
      }
      return callEnvironmentEnvelope(selector, method, params, timeoutMs)
    },
    subscribe: async (args, callbacks) => {
      const { selector, method, params, timeoutMs } = args
      if (method === 'browser.screencast' && window.orcaWorkspaceWindowNative) {
        const environment = configured(selector)
          ? await native!.resolve({ selector })
          : resolveEnvironment(selector)
        const nativeSubscription = await window.orcaWorkspaceWindowNative.subscribeBrowser(
          {
            runtimeId: environment.runtimeId,
            params,
            ...(configured(selector)
              ? {
                  environmentId: environment.id,
                  expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
                }
              : {})
          },
          callbacks
        )
        if (nativeSubscription) {
          return nativeSubscription
        }
      }
      if (configured(selector)) {
        return native!.subscribe(args, callbacks)
      }
      const environment = resolveEnvironment(selector)
      const client = getClientForEnvironment(environment)
      const subscription = await client.subscribe(method, params, callbacks, { timeoutMs })
      if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
        subscription.unsubscribe()
        throw new Error('runtime_manually_disconnected')
      }
      return subscription
    }
  }
}
