import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from './remote-runtime-client'

export type SharedControlConnectionState =
  | 'closed'
  | 'awaiting_ready'
  | 'awaiting_authenticated'
  | 'ready'

export type SharedControlPendingRequest<TResult> = {
  method: string
  resolve: (response: RuntimeRpcResponse<TResult>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type SharedControlSubscriptionCallbacks<TResult> = {
  onResponse: (response: RuntimeRpcResponse<TResult>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError: (error: RemoteRuntimeClientError) => void
  onClose?: () => void
}

export type SharedControlLogicalSubscription<TResult = unknown> = {
  requestId: string
  method: string
  params: unknown
  callbacks: SharedControlSubscriptionCallbacks<TResult>
  sent: boolean
  closed: boolean
  closeAfterReady: boolean
  remoteSubscriptionId: string | null
}

export type SharedControlReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

export type RemoteRuntimeSharedSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
}

export type RemoteRuntimeSharedConnectionDiagnostics = {
  state: SharedControlConnectionState | 'reconnecting'
  pendingRequestCount: number
  subscriptionCount: number
  reconnectAttempt: number
  lastConnectedAt: number | null
  lastClose: { code: number; reason: string } | null
  lastError: string | null
}
