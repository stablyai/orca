import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export type WebRuntimeSubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
  onTransportInterrupted?: () => void
  onTransportReplayed?: () => void
}

export type WebRuntimeTransportSubscription = {
  id: string
  method: string
  params: unknown
  callbacks: WebRuntimeSubscriptionCallbacks
  needsReplay: boolean
}

export type WebRuntimeSubscribeOptions = {
  timeoutMs?: number
  buildUnsubscribe?: (params: unknown) => { method: string; params: unknown } | null
}

export type WebRuntimeTransportSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}
