import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import type { RemoteRuntimePreparedRequest } from '../requests/remote-runtime-prepared-request-admission'
import type { RuntimeCapability } from '../../protocol-version'
import type {
  RemoteRuntimeSocketDeathCause,
  RemoteRuntimeSocketLivenessOptions
} from '../../remote-runtime-socket-liveness'

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
  preparedRequest?: RemoteRuntimePreparedRequest | null
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
  retainedParamsBytes: number
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
  /** Why the last socket closed; cleared when a socket becomes ready, like lastClose. */
  lastCloseCause?: SharedControlSocketCloseCause
  /** Last keepalive ping round trip; absent until one is measured. Not a publish trigger. */
  lastRttMs?: number
}

export type SharedControlSocketCloseCause =
  | RemoteRuntimeSocketDeathCause
  | 'socket_close'
  | 'socket_error'
  | 'protocol_error'
  | 'local'

export type SharedControlSocketClosed = (
  error: RemoteRuntimeClientError,
  socketGeneration: number,
  cause: SharedControlSocketCloseCause
) => void

export type SharedControlSocketClose = {
  cause: SharedControlSocketCloseCause
  errorCode: string | null
}

export type CloseSocketOptions = {
  preserveReadyWaitersAndPendingRequests?: boolean
  close?: SharedControlSocketClose
}

/** One closed control socket, for diagnostics; carries no hostnames, tokens or payloads. */
export type SharedControlSocketCloseRecord = SharedControlSocketClose & {
  closeCode: number | null
  state: SharedControlConnectionState
  lastRttMs: number | null
  socketUptimeMs: number | null
  readyUptimeMs: number | null
  reconnectAttempt: number
  pendingRequestCount: number
  subscriptionCount: number
}
export type RemoteRuntimeSharedControlConnectionOptions = {
  environmentId?: string
  clientCapabilities?: readonly RuntimeCapability[]
  isManuallyDisconnected?: () => boolean
  isCapabilityPaused?: () => boolean
  /** Publishes local transport diagnostics after a meaningful state transition. */
  onDiagnosticsChanged?: (diagnostics: RemoteRuntimeSharedConnectionDiagnostics) => void
  /** Any inbound frame, ping or pong on the current socket. */
  onAnswered?: () => void
  reconnectStableResetMs?: number
  /** Every socket close with its cause, e.g. for the diagnostics trace. */
  onSocketClosed?: (record: SharedControlSocketCloseRecord) => void
  liveness?: RemoteRuntimeSocketLivenessOptions
  /**
   * The server refused this socket's token. Null leaves the usual reconnect; a promise means the
   * caller owns recovery and says whether this connection should then retry or stay closed.
   */
  onAuthenticationRejected?: () => Promise<'retry' | 'stop'> | null
}
