import type { PreloadApi } from '../../../../preload/api-types'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/paired-runtime-connection'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { verifyRemotePairingRuntimeStatus } from '../../../../shared/remote-pairing-verification'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { WebRuntimeClient } from '../web-runtime-client'
import { isWebRuntimeUnauthorizedError } from '../web-runtime-client-error'
import {
  createStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'
import { translateHostAccessLinkError } from '@/lib/remote-pairing-copy'
import {
  closeActiveRuntimeClients,
  manuallyDisconnectedEnvironmentIds,
  webRuntimeState,
  getClientForEnvironment
} from './web-runtime-session'

export const verifyAndAddWebRuntimeEnvironment: NonNullable<
  PreloadApi['runtimeEnvironments']['verifyAndAddFromPairingCode']
> = async ({ name, pairingCode, allowLoopback, edgeAuthHeaders }) => {
  if (edgeAuthHeaders?.some((row) => row.name.trim() || row.value.trim())) {
    return {
      ok: false,
      kind: 'access-link-invalid',
      message:
        'Use your browser login for this protected tunnel. Service-token headers are available only in the native app.'
    }
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
    client = new WebRuntimeClient(pairedRuntimeConnectionFromOffer(parsed.value.pairing))
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
  getClientForEnvironment(nextEnvironment).statusOwner?.acceptVerified({
    id: 'status.get',
    ok: true,
    result: runtimeStatus,
    _meta: { runtimeId: runtimeStatus.runtimeId }
  })
  return {
    ok: true,
    environment: redactStoredWebRuntimeEnvironment(nextEnvironment),
    runtimeStatus
  }
}
