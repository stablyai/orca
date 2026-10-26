import type { PairedRuntimeConnection } from './paired-runtime-connection'
import type { RuntimeCapability } from './protocol-version'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from './remote-runtime/requests/remote-runtime-subscription-transport'
import type {
  RemoteRuntimeSubscriptionOptions,
  RemoteRuntimeTransportSubscriptionCallbacks
} from './remote-runtime/requests/remote-runtime-subscription-contract'
import type {
  ExpectedRuntimeSource,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'

export type RemoteRuntimeSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type RemoteRuntimeSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

/** Sends one authenticated remote request, keeping its runtime pin separate from forwarded metadata. */
export function sendRemoteRuntimeRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = [],
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    connection,
    method,
    params,
    timeoutMs,
    envelope,
    undefined,
    signal,
    clientCapabilities,
    expectedRuntimeSource
  )
}

/** Runs the supplied status validator before the requested RPC on the same authenticated socket. */
export function sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope,
  clientCapabilities: readonly RuntimeCapability[] = [],
  signal?: AbortSignal,
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    connection,
    method,
    params,
    timeoutMs,
    envelope,
    validateStatus,
    signal,
    clientCapabilities,
    expectedRuntimeSource
  )
}

export function subscribeRemoteRuntimeRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks<TResult>,
  options?: RemoteRuntimeSubscriptionOptions
): Promise<RemoteRuntimeSubscription> {
  return subscribeRemoteRuntimeTransport(
    connection,
    method,
    params,
    timeoutMs,
    callbacks as RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
    options
  )
}
