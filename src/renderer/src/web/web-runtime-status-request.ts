import { verifyRemotePairingRuntimeStatus } from '../../../shared/remote-pairing-verification'
import {
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse
} from '../../../shared/runtime-host-status'
import type { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

export async function readWebRuntimeStatus(
  transport: WebRuntimeConnectionTransport,
  signal: AbortSignal
): Promise<RuntimeHostStatusResponse> {
  const epoch = transport.requestRegistry.connectionEpoch
  const response = await transport.call('status.get', undefined, {
    timeoutMs: 15_000,
    signal
  })
  if (epoch !== transport.requestRegistry.connectionEpoch) {
    return runtimeHostStatusFailure('runtime_unavailable', 'Runtime connection changed.')
  }
  if (!response.ok) {
    return response
  }
  const decoded = verifyRemotePairingRuntimeStatus(response.result)
  return decoded.ok
    ? { ...response, result: decoded.runtimeStatus }
    : runtimeHostStatusFailure(
        decoded.kind === 'protocol-incompatible'
          ? 'protocol_version_mismatch'
          : decoded.kind === 'access-link-invalid'
            ? 'unauthorized'
            : 'invalid_runtime_response',
        decoded.message
      )
}
