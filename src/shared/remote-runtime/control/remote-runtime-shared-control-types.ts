import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { RemoteRuntimePreparedRequest } from '../requests/remote-runtime-prepared-request-admission'
import type { RuntimeCapability } from '../../protocol-version'
import type {
  RemoteRuntimeSocketDeathCause,
  RemoteRuntimeSocketLivenessOptions
} from '../remote-runtime-socket-liveness'

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
  // Only opted-in long-polls refresh on unrelated keepalives; short RPCs time out independently of socket liveness.
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
  // Tag the first replay response as an authoritative snapshot so freshness gates accept it (#7718).
  pendingReplayTag?: boolean
  // While resubscribe awaits its ID, close must defer cleanup or leak the server’s new subscription.
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
  /** Null uses normal retry; a promise owns token recovery and decides whether this connection retries. */
  onAuthenticationRejected?: () => Promise<'retry' | 'stop'> | null
}
