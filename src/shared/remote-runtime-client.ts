import type { PairingOffer } from './pairing'
import type { RuntimeCapability } from './protocol-version'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'
import {
  subscribeRemoteRuntimeTransport,
  type RemoteRuntimeSubscriptionOptions,
  type RemoteRuntimeTransportSubscriptionCallbacks
} from './remote-runtime-subscription-transport'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'

export { RemoteRuntimeClientError } from './remote-runtime-client-error'
export type {
  RemoteRuntimeOutboundMemoryBudget,
  RemoteRuntimeOutboundSocketMemory,
  RemoteRuntimeSubscriptionOptions
} from './remote-runtime-subscription-transport'

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
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = []
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    pairing,
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
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope,
  clientCapabilities: readonly RuntimeCapability[] = []
): Promise<RuntimeRpcResponse<TResult>> {
  return sendRemoteRuntimeRequestOnSocket(
    pairing,
    method,
    params,
    timeoutMs,
    envelope,
    validateStatus,
    undefined,
    clientCapabilities
  )
}

export function subscribeRemoteRuntimeRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks<TResult>,
  options?: RemoteRuntimeSubscriptionOptions
): Promise<RemoteRuntimeSubscription> {
  return subscribeRemoteRuntimeTransport(
    pairing,
    method,
    params,
    timeoutMs,
    callbacks as RemoteRuntimeTransportSubscriptionCallbacks<TResult>,
    options
  )
}
