import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { RuntimeCapability } from './protocol-version'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeSocketLivenessOptions } from './remote-runtime-socket-liveness'
import type {
  RemoteRuntimeOutboundMemoryBudget,
  RemoteRuntimeOutboundQueueOptions
} from './remote-runtime-subscription-outbound'

export type RemoteRuntimeTransportSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type RemoteRuntimeTransportSubscriptionCallbacks<TResult = unknown> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export type RemoteRuntimeSubscriptionOptions = RemoteRuntimeSocketLivenessOptions & {
  clientCapabilities?: readonly RuntimeCapability[]
  perMessageDeflate?: boolean
  outboundQueue?: RemoteRuntimeOutboundQueueOptions
  outboundMemoryBudget?: RemoteRuntimeOutboundMemoryBudget
  // Why: overridable so the connect-bound regression test can pin the ordering against the
  // subscription-start timer without spending production wall-clock.
  connectTimeoutMs?: number
}
