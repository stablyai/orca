import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedControlConnectionOptions,
  SharedControlConnectionState
} from './remote-runtime-shared-control-types'

type DiagnosticClose = { code: number; reason: string } | null

export class SharedControlDiagnosticsTracker {
  private lastConnectedAt: number | null = null
  private lastClose: DiagnosticClose = null
  private lastError: string | null = null
  private lastPublished: RemoteRuntimeSharedConnectionDiagnostics | null = null

  constructor(private readonly options: RemoteRuntimeSharedControlConnectionOptions) {}

  markClose(close: DiagnosticClose): void {
    this.lastClose = close
  }

  markReady(): void {
    this.lastConnectedAt = Date.now()
    this.lastError = null
    this.lastClose = null
  }

  markError(error: string): void {
    this.lastError = error
  }

  get(args: {
    state: SharedControlConnectionState
    reconnecting: boolean
    pendingRequestCount: number
    subscriptionCount: number
    reconnectAttempt: number
  }): RemoteRuntimeSharedConnectionDiagnostics {
    return {
      state: args.reconnecting ? 'reconnecting' : args.state,
      pendingRequestCount: args.pendingRequestCount,
      subscriptionCount: args.subscriptionCount,
      reconnectAttempt: args.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastClose: this.lastClose,
      lastError: this.lastError
    }
  }

  publish(args: Parameters<SharedControlDiagnosticsTracker['get']>[0]): void {
    const diagnostics = this.get(args)
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
