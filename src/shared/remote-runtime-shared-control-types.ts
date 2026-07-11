import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'

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
  // Why: keepalives on the shared socket are armed for an unrelated long-poll,
  // not this request. Only requests that opt in (long-polls issued via the
  // short-RPC path) may have their deadline refreshed by a keepalive; ordinary
  // short RPCs keep an absolute deadline so a stuck server call still times
  // out, tears the socket down, and reconnects/replays as designed.
  refreshTimeoutOnKeepalive: boolean
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
  // Why: set while awaiting the first response after a reconnect replay; that
  // response is the authoritative re-emitted snapshot and gets tagged so
  // monotonic freshness gates don't drop it (#7718).
  pendingReplayTag?: boolean
  // Why: true from the moment a reconnect replay clears remoteSubscriptionId
  // until the resubscribe response arrives. A close() during this window has no
  // id to unsubscribe by yet, so it must defer instead of finishing locally —
  // otherwise the resubscribe the server is about to accept leaks.
  awaitingResubscribe?: boolean
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
