import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedControlConnectionOptions,
  SharedControlConnectionState,
  SharedControlSocketClose,
  SharedControlSocketCloseCause,
  SharedControlSocketCloseRecord
} from './remote-runtime-shared-control-types'

type DiagnosticClose = { code: number; reason: string } | null

type SharedControlDiagnosticsCounts = {
  state: SharedControlConnectionState
  reconnecting: boolean
  pendingRequestCount: number
  subscriptionCount: number
  reconnectAttempt: number
}

export class SharedControlDiagnosticsTracker {
  private lastConnectedAt: number | null = null
  private lastClose: DiagnosticClose = null
  private lastError: string | null = null
  private lastCloseCause: SharedControlSocketCloseCause | null = null
  private lastRttMs: number | null = null
  private socketOpenedAt: number | null = null
  private lastPublished: RemoteRuntimeSharedConnectionDiagnostics | null = null

  constructor(
    private readonly options: RemoteRuntimeSharedControlConnectionOptions,
    private readonly counts: () => SharedControlDiagnosticsCounts
  ) {}

  markClose(close: DiagnosticClose): void {
    this.lastClose = close
  }

  markReady(): void {
    this.lastConnectedAt = Date.now()
    this.lastError = null
    this.lastClose = null
    this.lastCloseCause = null
  }

  markSocketOpened(): void {
    this.socketOpenedAt = Date.now()
    // Why: an RTT belongs to the socket it was measured on, not its replacement.
    this.lastRttMs = null
  }

  markRoundTrip(rttMs: number): void {
    this.lastRttMs = rttMs
  }

  /** Records why the current socket closed and reports it; never throws into the close path. */
  markSocketClosed(close: SharedControlSocketClose): void {
    const counts = this.counts()
    const closedAt = Date.now()
    const record: SharedControlSocketCloseRecord = {
      ...close,
      closeCode: close.cause === 'socket_close' ? (this.lastClose?.code ?? null) : null,
      state: counts.state,
      lastRttMs: this.lastRttMs,
      socketUptimeMs: this.socketOpenedAt === null ? null : closedAt - this.socketOpenedAt,
      readyUptimeMs:
        counts.state === 'ready' && this.lastConnectedAt !== null
          ? closedAt - this.lastConnectedAt
          : null,
      reconnectAttempt: counts.reconnectAttempt,
      pendingRequestCount: counts.pendingRequestCount,
      subscriptionCount: counts.subscriptionCount
    }
    this.lastCloseCause = close.cause
    this.socketOpenedAt = null
    try {
      this.options.onSocketClosed?.(record)
    } catch (error) {
      console.warn('[remote-runtime.shared-control] socket close callback failed:', error)
    }
  }

  markError(error: string): void {
    this.lastError = error
  }

  get(): RemoteRuntimeSharedConnectionDiagnostics {
    const args = this.counts()
    return {
      state: args.reconnecting ? 'reconnecting' : args.state,
      pendingRequestCount: args.pendingRequestCount,
      subscriptionCount: args.subscriptionCount,
      reconnectAttempt: args.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastClose: this.lastClose,
      lastError: this.lastError,
      ...(this.lastCloseCause ? { lastCloseCause: this.lastCloseCause } : {}),
      ...(this.lastRttMs === null ? {} : { lastRttMs: this.lastRttMs })
    }
  }

  publish(): void {
    const diagnostics = this.get()
    const previous = this.lastPublished
    const closeUnchanged =
      previous?.lastClose?.code === diagnostics.lastClose?.code &&
      previous?.lastClose?.reason === diagnostics.lastClose?.reason
    if (
      previous &&
      previous.state === diagnostics.state &&
      previous.pendingRequestCount === diagnostics.pendingRequestCount &&
      previous.subscriptionCount === diagnostics.subscriptionCount &&
      previous.reconnectAttempt === diagnostics.reconnectAttempt &&
      previous.lastConnectedAt === diagnostics.lastConnectedAt &&
      closeUnchanged &&
      previous.lastCloseCause === diagnostics.lastCloseCause &&
      previous.lastError === diagnostics.lastError
    ) {
      return
    }
    this.lastPublished = diagnostics
    try {
      this.options.onDiagnosticsChanged?.(diagnostics)
    } catch (error) {
      console.warn('[remote-runtime.shared-control] diagnostics callback failed:', error)
    }
  }
}
