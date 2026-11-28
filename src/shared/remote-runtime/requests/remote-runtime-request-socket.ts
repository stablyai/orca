import {
  refuseRelayOnlyHostWithoutLink,
  remoteRuntimeOneLinkFor,
  sendRemoteRuntimeRequestOnOneLink
} from '../control/remote-runtime-one-link'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import type { RuntimeCapability } from '../protocol/protocol-version'
import type { RemoteRuntimeClientHandshake } from '../remote-runtime-client-framing'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeRequestSelection,
  RuntimeRpcResponse
} from '../rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../session-graph/runtime-session-contracts'
import { sendRemoteRuntimeRequestOnOwnSocket } from './remote-runtime-request-own-socket'

/**
 * One call to a paired runtime. A host on one link (remote-runtime-one-link.ts) takes it there;
 * any other host gets a socket of its own for it.
 */
export async function sendRemoteRuntimeRequestOnSocket<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = [],
  requestSelection?: RuntimeRequestSelection,
  prepareRequest?: RuntimeRequestPreparation,
  // Internal: the framing fallback's legacy status check on a latched host uses exactly this dial.
  latchedHostCheck?: RemoteRuntimeClientHandshake,
  prepareGuard?: RuntimeRequestGuard,
  /** Replaces timeoutMs once the host authenticates, so only a reachable host gets a long reply wait. */
  responseTimeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const oneLink = latchedHostCheck ? null : remoteRuntimeOneLinkFor(connection)
  if (oneLink) {
    signal?.throwIfAborted()
    return await sendRemoteRuntimeRequestOnOneLink<TResult>(oneLink, {
      method,
      params,
      timeoutMs,
      envelope,
      validateStatus,
      signal,
      requestSelection,
      prepareRequest,
      prepareGuard,
      responseTimeoutMs
    })
  }
  refuseRelayOnlyHostWithoutLink(connection)
  return await sendRemoteRuntimeRequestOnOwnSocket<TResult>(
    connection,
    method,
    params,
    timeoutMs,
    envelope,
    validateStatus,
    signal,
    clientCapabilities,
    requestSelection,
    prepareRequest,
    latchedHostCheck,
    prepareGuard,
    responseTimeoutMs
  )
}
