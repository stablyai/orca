import type { PairedRuntimeConnection } from '../paired-runtime-connection'
import type { RuntimeCapability } from '../protocol-version'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { sendRemoteRuntimeRequestOnSocket } from './requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from './requests/remote-runtime-subscription-transport'
import type {
  RemoteRuntimeSubscriptionOptions,
  RemoteRuntimeTransportSubscriptionCallbacks
} from './requests/remote-runtime-subscription-contract'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from '../runtime-rpc-envelope'
import type { RuntimeStatus } from '../runtime-session-contracts'

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

export function sendRemoteRuntimeRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = []
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    connection,
    method,
    params,
    timeoutMs,
    envelope,
    undefined,
    signal,
    clientCapabilities
  )
}

export function sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope,
  clientCapabilities: readonly RuntimeCapability[] = [],
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    connection,
    method,
    params,
    timeoutMs,
    envelope,
    validateStatus,
    signal,
    clientCapabilities
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
