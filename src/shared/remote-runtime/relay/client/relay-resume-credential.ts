import type { RpcResponse } from '../../rpc/rpc-response-shape'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceCredentialInstalled,
  type DeviceResumeConfirmed,
  type MobileRelayEndpoint,
  type PairingGetEndpointsParams,
  type PairingGetEndpointsResult
} from '../mobile-relay-credential-contract'
import type { RelayRpcClient } from './relay-rpc-client'

/** A minted resume credential the caller may persist before installing, so a lost reply retries the same reqId. */
export type PendingRelayResumeCredential = { token: string; hash: string; reqId: string }

/**
 * Installs a resume credential's hash with the relay through the host, idempotent per reqId. Only the
 * host's committed install status promotes it; provision's own reply never does.
 */
export async function installRelayResumeCredential(
  client: RelayRpcClient,
  pending: PendingRelayResumeCredential,
  expectedCurrentHash?: string
): Promise<{ installed: DeviceCredentialInstalled; relay: MobileRelayEndpoint }> {
  let endpoints = await readEndpoints(client, { installReqId: pending.reqId })
  if (endpoints.installStatus?.state !== 'committed') {
    const installed = DeviceCredentialInstalledSchema.parse(
      resultOf(
        await client.sendRequest('pairing.provisionRelay', {
          reqId: pending.reqId,
          newResumeTokenHash: pending.hash,
          ...(expectedCurrentHash ? { expectedCurrentHash } : {})
        })
      )
    )
    endpoints = await readEndpoints(client, { installReqId: pending.reqId })
    if (
      endpoints.installStatus?.state !== 'committed' ||
      JSON.stringify(endpoints.installStatus.result) !== JSON.stringify(installed)
    ) {
      throw new Error('relay resume credential was not authoritatively committed')
    }
  }
  if (!endpoints.relay || endpoints.installStatus?.state !== 'committed') {
    throw new Error('relay resume credential endpoint state missing')
  }
  return { installed: endpoints.installStatus.result, relay: endpoints.relay }
}

/** Confirms a resumed connection with the host, which renews the credential's expiry. */
export async function confirmRelayResume(
  client: RelayRpcClient,
  resumeConfirmReqId: string,
  relayHostId: string
): Promise<DeviceResumeConfirmed> {
  const endpoints = await readEndpoints(client, { resumeConfirmReqId })
  if (!endpoints.resumeConfirmation || endpoints.relay?.relayHostId !== relayHostId) {
    throw new Error('relay resume confirmation missing')
  }
  return endpoints.resumeConfirmation
}

async function readEndpoints(
  client: RelayRpcClient,
  params: PairingGetEndpointsParams
): Promise<PairingGetEndpointsResult> {
  return PairingGetEndpointsResultSchema.parse(
    resultOf(await client.sendRequest('pairing.getEndpoints', params))
  )
}

function resultOf(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error.code)
  }
  return response.result
}
