import type { RuntimeRpcResponse } from '../rpc/runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { RemoteRuntimePreparedRequest } from '../requests/remote-runtime-prepared-request-admission'
import type { RuntimeCapability } from '../protocol/protocol-version'
import type {
  RemoteRuntimeSocketDeathCause,
  RemoteRuntimeSocketLivenessOptions
} from '../remote-runtime-socket-liveness'
import type { RemoteRuntimeSealedFrame } from '../remote-runtime-sealed-frame'
import type { SharedControlAppHeartbeatOptions } from './remote-runtime-shared-control-app-heartbeat'
import type { AuthenticatedRuntimeChannelOpener } from './remote-runtime-authenticated-channel'

/** Text, or binary that may carry compressed text; nothing else reaches the shared control socket. */
export type SharedControlFrame = RemoteRuntimeSealedFrame

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
  /**
   * The binary channel of a stream that would have had a socket of its own. Such a stream ends
   * when the connection's socket does, as its own socket's stream did; its owner reopens it.
   */
  binaryChannel?: number
  /** What the stream's own socket would have declared; the host reads the channel's calls by it. */
  channelCapabilities?: readonly RuntimeCapability[]
  /** Background traffic, as the stream's own socket marked its opening request. */
  idlePassive?: boolean
}

export type SharedControlReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

export type RemoteRuntimeSharedSubscription = {
  requestId: string
  close: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  /** A call on the stream's own channel, as it was sent on the stream's own socket. */
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
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
  /** When the runtime first missed an app-level heartbeat; kept across reconnects until it answers again. */
  unresponsiveSince?: number
}

export type SharedControlSocketCloseCause =
  | RemoteRuntimeSocketDeathCause
  | 'socket_close'
  | 'socket_error'
  | 'protocol_error'
  | 'ready_timeout'
  /** The socket stayed open but the runtime missed an app-level heartbeat. */
  | 'runtime_unresponsive'
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
  /** Orca's own idle stop holds this server down: no socket is opened or retried until cleared. */
  isIdleStopped?: () => boolean
  /** The server closed this socket saying it stopped idle, before the close is handled. */
  onIdleStop?: () => void
  /** The server's VM is asleep: no socket is opened or retried until its workspace wakes it. */
  prepareSleepCheck?: () => (() => boolean) | Promise<() => boolean>
  /** Publishes local transport diagnostics after a meaningful state transition. */
  onDiagnosticsChanged?: (diagnostics: RemoteRuntimeSharedConnectionDiagnostics) => void
  /** Any inbound frame, ping or pong on the current socket. */
  onAnswered?: () => void
  /** Each socket that becomes ready, including after every reconnect. */
  onReady?: () => void
  reconnectStableResetMs?: number
  /** OPEN→ready bound before the socket is retired; defaults to 30s. */
  readyDeadlineMs?: number
  /** Every socket close with its cause, e.g. for the diagnostics trace. */
  onSocketClosed?: (record: SharedControlSocketCloseRecord) => void
  liveness?: RemoteRuntimeSocketLivenessOptions
  /** Opt-in app-level heartbeat on ready sockets; absent keeps transport-only liveness. */
  appHeartbeat?: SharedControlAppHeartbeatOptions
  /** Null uses normal retry; a promise owns token recovery and decides whether this connection retries. */
  onAuthenticationRejected?: () => Promise<'retry' | 'stop' | null> | null
  /**
   * Opens the authenticated channel declaring these capabilities, e.g. over Relay; absent opens a
   * direct socket to the endpoint.
   */
  openChannel?: (clientCapabilities: readonly string[]) => AuthenticatedRuntimeChannelOpener
  /** Carry streams' binary on this one connection (both sides must support binary channels). */
  binaryChannels?: boolean
}
