import { SharedControlRequests } from './remote-runtime-shared-control-requests'
import * as pairing from '../pairing/paired-runtime-connection'
import { schedulePreparedControlRetry } from './remote-runtime-shared-control-hold'
import { openPreparedSharedControlChannel } from './remote-runtime-shared-control-open'
import type { AuthenticatedRuntimeChannel } from './remote-runtime-authenticated-channel'
import { controlChannelOpener } from './remote-runtime-direct-authenticated-channel'
import type { SharedControlBinaryChannels } from './remote-runtime-shared-control-binary-channels'
import { resolveSharedControlReadyWaiters } from './remote-runtime-shared-control-state'
import { readSharedControlChannelFrame } from './remote-runtime-shared-control-frame-dispatch'
import { controlBinaryChannels, releaseControlOneLink } from './remote-runtime-one-link'
import { closeSharedControlAfterError } from './remote-runtime-shared-control-refusal'
import * as sharedControlReady from './remote-runtime-shared-control-ready'
import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { SharedControlReadinessTimer } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import * as socketClose from './remote-runtime-shared-control-socket-close'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import { refreshRemoteRuntimeSharedControl } from './remote-runtime-shared-control-refresh'
import { SharedControlDiagnosticsTracker } from './remote-runtime-shared-control-diagnostics'
import { ensureSharedControlReady } from './remote-runtime-shared-control-ready-wait'
import * as sharedControlActions from './remote-runtime-shared-control-connection-actions'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'
import { closeSharedControlConnectionSubscription } from '../requests/remote-runtime-shared-control-subscription-close'
type PendingRequest = SharedControlTypes.SharedControlPendingRequest<unknown>
type LogicalSubscription = SharedControlTypes.SharedControlLogicalSubscription<unknown>

export class RemoteRuntimeSharedControlConnection {
  private state: SharedControlTypes.SharedControlConnectionState = 'closed'
  private channel: AuthenticatedRuntimeChannel | null = null
  private readonly reconnect = new SharedControlReconnectScheduler()
  private readonly readiness: SharedControlReadinessTimer
  private intentionallyClosed = false
  private readonly diagnostics: SharedControlDiagnosticsTracker
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, LogicalSubscription>()
  private readonly retiredRequestIds = new SharedControlRetiredRequestIds()
  private readonly readyWaiters: SharedControlTypes.SharedControlReadyWaiter[] = []
  private opening: number | null = null
  private retryEpoch = 0
  private everReady = false
  /** Changes whenever the socket does, so two calls can prove they shared one socket. */
  readonly socketGeneration = new SharedControlSocketGeneration()

  private readonly requests = new SharedControlRequests({
    connection: () => this.connection,
    pendingRequests: this.pendingRequests,
    subscriptions: this.subscriptions,
    retiredRequestIds: this.retiredRequestIds,
    ensureReady: (timeoutMs, signal) => this.ensureReadyWithTimeout(timeoutMs, signal),
    sendEncrypted: (payload) => this.sendEncrypted(payload),
    closeSubscription: (id) => this.closeSubscription(id),
    captureSendGuard: () => this.socketGeneration.captureReady(() => this.isReady()),
    wire: () => ({ state: this.state, channel: this.channel }),
    binaryChannels: () => this.binaryChannels
  })
  /** Binary streams sharing this one connection; null keeps them on sockets of their own. */
  private readonly binaryChannels: SharedControlBinaryChannels | null

  constructor(
    private readonly connection: pairing.PairedRuntimeConnection,
    private readonly options: SharedControlTypes.RemoteRuntimeSharedControlConnectionOptions = {}
  ) {
    this.diagnostics = new SharedControlDiagnosticsTracker(options, () => ({
      state: this.state,
      reconnecting: this.reconnect.isScheduled,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnect.attemptCount,
      unresponsiveSince: this.readiness.unresponsiveSince
    }))
    this.readiness = new SharedControlReadinessTimer(options, {
      getState: () => this.state,
      isOpen: () => this.channel?.state() === 'open',
      resetAttempt: () => this.reconnect.resetAttempt(),
      retire: this.handleSocketClosed,
      probe: (timeoutMs) => this.request('status.get', { probe: true }, timeoutMs),
      onHealthChanged: this.publishDiagnostics
    })
    this.binaryChannels = controlBinaryChannels(this, {
      connection,
      enabled: options.binaryChannels,
      subscriptions: this.subscriptions,
      send: (frame) => this.isReady() && this.channel!.sendBinary(frame)
    })
  }
  request<TResult>(...args: Parameters<SharedControlRequests['request']>) {
    return this.requests.request<TResult>(...args)
  }
  subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlTypes.SharedControlSubscriptionCallbacks<TResult>,
    signal?: AbortSignal,
    /** A stream that would otherwise need a socket of its own: it gets a binary channel. */
    stream?: Parameters<SharedControlRequests['subscribe']>[5]
  ) {
    return this.requests.subscribe<TResult>(method, params, timeoutMs, callbacks, signal, stream)
  }
  close(error?: Error): void {
    releaseControlOneLink(this)
    this.intentionallyClosed = true
    this.opening = null
    this.retryEpoch += 1
    this.socketGeneration.invalidate()
    this.reconnect.clear()
    // Its channel streams end with it, as on a drop; their owners hear once it closed.
    const notifyChannelStreams = socketClose.channelStreamsEndedByClose(this.subscriptions)
    Array.from(this.subscriptions.keys()).forEach((id) => this.closeSubscription(id))
    this.closeSocket(error)
    notifyChannelStreams()
    this.publishDiagnostics()
  }
  readonly retryNow = (): boolean => this.reconnect.retryNow()
  pauseStandingRetry(): void {
    if (this.subscriptions.size === 0) {
      this.retryEpoch += 1
      this.reconnect.clear()
      this.publishDiagnostics()
    }
  }

  private readonly publishDiagnostics = (): void => this.diagnostics.publish()
  isReady(): boolean {
    return sharedControlReady.isSharedControlReady({ state: this.state, channel: this.channel })
  }
  getDiagnostics = (): SharedControlTypes.RemoteRuntimeSharedConnectionDiagnostics =>
    this.diagnostics.get()
  reconnectNow(): void {
    refreshRemoteRuntimeSharedControl({
      intentionallyClosed: this.intentionallyClosed,
      ready: this.isReady(),
      close: (error) => this.closeSocket(error, { preserveReadyWaitersAndPendingRequests: true }),
      open: () => this.open()
    })
  }
  private ensureReadyWithTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return ensureSharedControlReady({
      state: this.state,
      channel: this.channel,
      readyWaiters: this.readyWaiters,
      timeoutMs,
      signal,
      open: () => sharedControlReady.openIfChannelClosed(this.channel, () => this.open())
    })
  }

  private open(): void {
    if (this.opening !== null || this.intentionallyClosed) {
      return
    }
    this.reconnect.clear()
    const generation = this.socketGeneration.begin()
    this.opening = generation
    const demand = this.readyWaiters.length > 0
    const current = (): boolean => this.socketGeneration.isCurrent(generation)
    const read = (frame: string | Uint8Array<ArrayBufferLike>): false | void =>
      current() &&
      readSharedControlChannelFrame(frame, {
        environmentId: this.options.environmentId,
        pendingRequests: this.pendingRequests,
        subscriptions: this.subscriptions,
        retiredRequestIds: this.retiredRequestIds,
        deviceToken: pairing.pairedRuntimeConnectionToken(this.connection),
        send: (payload) => this.sendEncrypted(payload),
        binaryChannels: this.binaryChannels,
        fail: (error) => this.handleSocketClosed(error, generation, 'protocol_error')
      })
    void openPreparedSharedControlChannel(this.options, {
      current: () => current() && !this.intentionallyClosed,
      prepared: () => void (this.opening = null),
      hasDemand: () => !demand || this.readyWaiters.length > 0 || this.subscriptions.size > 0,
      refuse: (error) =>
        sharedControlState.rejectSharedControlReadyWaiters(this.readyWaiters, error),
      opener: controlChannelOpener(this.connection, this.options, this.binaryChannels !== null),
      events: {
        onTransportOpen: () => current() && this.readiness.armReadyDeadline(generation),
        onAuthenticating: () => {
          if (current()) {
            this.state = 'awaiting_authenticated'
            this.publishDiagnostics()
          }
        },
        onAuthenticated: () => current() && this.markAuthenticated(generation),
        onText: read,
        onBinary: read,
        onAnswer: () => current() && this.readiness.noteAnswer(),
        onActivity: () => current() && this.options.onAnswered?.(),
        onRoundTrip: (rttMs) => current() && this.diagnostics.markRoundTrip(rttMs),
        onClosed: (error, cause, close) => {
          if (close && current()) {
            this.diagnostics.markClose(close)
          }
          this.handleSocketClosed(error, generation, cause)
        }
      },
      accept: (opened) => {
        if (!opened.ok) {
          this.handleSocketClosed(opened.error, generation, 'socket_error')
          return
        }
        this.diagnostics.markSocketOpened()
        this.channel = opened.channel
        this.state = 'awaiting_ready'
        this.publishDiagnostics()
      }
    }).catch((error: unknown) => {
      if (!this.socketGeneration.isCurrent(generation)) {
        return
      }
      this.opening = null
      sharedControlState.rejectSharedControlReadyWaiters(
        this.readyWaiters,
        error instanceof Error ? error : new Error(String(error))
      )
    })
  }

  private markAuthenticated(generation: number): void {
    this.state = 'ready'
    this.diagnostics.markReady()
    this.options.onReady?.()
    // Clear predecessor-attempt diagnostics on recovery so Connected cannot retain stale failure details.
    this.publishDiagnostics()
    this.readiness.scheduleStableReset(generation)
    resolveSharedControlReadyWaiters(this.readyWaiters)
    this.replaySubscriptions()
  }

  private replaySubscriptions(): void {
    this.everReady = sharedControlActions.replayRuntimeControlSubscriptions({
      subscriptions: this.subscriptions,
      deviceToken: pairing.pairedRuntimeConnectionToken(this.connection),
      send: (payload) => this.sendEncrypted(payload),
      tagReplayedResponses: this.everReady
    })
  }

  private closeSubscription(requestId: string): void {
    this.binaryChannels?.close(this.subscriptions.get(requestId))
    closeSharedControlConnectionSubscription({
      subscriptions: this.subscriptions,
      retiredRequestIds: this.retiredRequestIds,
      requestId,
      deviceToken: pairing.pairedRuntimeConnectionToken(this.connection),
      send: (payload) => this.sendEncrypted(payload)
    })
  }

  private readonly sendEncrypted = (payload: unknown): boolean =>
    sharedControlProtocol.sendSharedControlEncrypted({
      state: this.state,
      channel: this.channel,
      payload
    })

  private readonly handleSocketClosed: SharedControlTypes.SharedControlSocketClosed = (
    refused,
    generation,
    cause
  ) => {
    closeSharedControlAfterError({
      refused,
      socketGeneration: generation,
      generation: this.socketGeneration,
      onAuthenticationRejected: this.options.onAuthenticationRejected,
      everReady: this.everReady,
      subscriptions: this.subscriptions,
      closeSocket: (error) =>
        this.closeSocket(error, { close: { cause, errorCode: refused.code } }),
      markError: (message) => this.diagnostics.markError(message),
      isClosed: () => this.state === 'closed',
      retry: () => this.scheduleRetry(),
      publishDiagnostics: () => this.publishDiagnostics()
    })
  }

  private scheduleRetry(): void {
    const generation = this.socketGeneration.peek()
    const epoch = this.retryEpoch
    schedulePreparedControlRetry(this.options, {
      current: () =>
        this.socketGeneration.isCurrent(generation) &&
        epoch === this.retryEpoch &&
        !this.intentionallyClosed &&
        this.state === 'closed' &&
        this.opening === null,
      subscriptionCount: () => this.subscriptions.size,
      reconnect: this.reconnect,
      open: () => this.open(),
      publish: this.publishDiagnostics
    })
  }

  private closeSocket(error?: Error, options: SharedControlTypes.CloseSocketOptions = {}): void {
    const notifyEndedStreams = socketClose.closeSharedControlSocket({
      reportClose: () =>
        this.diagnostics.markSocketClosed(options.close ?? socketClose.LOCAL_CLOSE),
      environmentId: this.options.environmentId,
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      lastClose: this.getDiagnostics().lastClose,
      channel: this.channel,
      error,
      preserveReadyWaitersAndPendingRequests: options.preserveReadyWaitersAndPendingRequests,
      clearReadinessTimer: () => this.readiness.clear()
    })
    this.channel = null
    this.state = 'closed'
    this.publishDiagnostics()
    notifyEndedStreams()
  }
}
