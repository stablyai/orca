import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../../shared/runtime-types'
import { RemoteBrowserPageSession } from './remote-browser-page-session'
import { openRemoteBrowserScreencastStream } from './remote-browser-screencast-subscription'
import { RemoteBrowserStreamRestartScheduler } from './remote-browser-stream-restart-scheduler'
import { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import { createRemoteBrowserStreamRestartAttempt } from './remote-browser-stream-restart-attempt'
import {
  REMOTE_BROWSER_STREAM_LIVE,
  REMOTE_BROWSER_STREAM_OPENING,
  remoteBrowserStreamLostNotice,
  remoteBrowserStreamRetrying,
  remoteBrowserStreamStopped,
  REMOTE_BROWSER_STREAM_IDLE,
  remoteBrowserStreamNotice,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'
import {
  isRemoteBrowserPageMissingError,
  remoteBrowserStreamUnsupportedError,
  resolveRemoteBrowserStreamFailure
} from './remote-browser-stream-errors'
import {
  areRemoteViewportSizesNear,
  RemoteBrowserOperationTokens,
  type RemoteBrowserStreamSubscription,
  type RemoteBrowserStreamToken,
  type RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
export type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'

// Own one pane’s screencast and bounded recovery outside React so races can be driven with injected dependencies.
export class RemoteBrowserStreamLifecycle {
  readonly tokens: RemoteBrowserOperationTokens
  readonly session: RemoteBrowserPageSession
  private readonly restartScheduler: RemoteBrowserStreamRestartScheduler
  private subscription: RemoteBrowserStreamSubscription | null = null
  private streamViewportSize: RemoteBrowserViewportSize | null = null
  private readonly liveness = new RemoteBrowserStreamLiveness()
  private status: RemoteBrowserStreamStatus = REMOTE_BROWSER_STREAM_IDLE

  constructor(private readonly deps: RemoteBrowserStreamLifecycleDeps) {
    this.tokens = new RemoteBrowserOperationTokens(deps.identity)
    this.session = new RemoteBrowserPageSession({ ...deps, tokens: this.tokens })
    // Attempts can end before ready without throwing; exhaustion still needs a notice containing Reconnect.
    this.restartScheduler = new RemoteBrowserStreamRestartScheduler(undefined, () =>
      this.setStatus(
        remoteBrowserStreamStopped(
          remoteBrowserStreamNotice(this.status) ?? remoteBrowserStreamLostNotice()
        )
      )
    )
  }

  private setStatus(status: RemoteBrowserStreamStatus): void {
    this.status = status
    this.deps.setStatus(status)
  }

  forgetStreamViewportSize(): void {
    this.streamViewportSize = null
  }

  open(): () => void {
    let cancelled = false
    const { tokens, deps } = this
    // Reopening starts a fresh budget and replaces any exhausted status.
    this.setStatus(REMOTE_BROWSER_STREAM_OPENING)
    this.retireInFlightWork()?.unsubscribe()
    const operationToken = tokens.createOperationToken()
    if (!operationToken) {
      this.setStatus(REMOTE_BROWSER_STREAM_IDLE)
      return () => {}
    }
    void this.session
      .ensureRemotePage(operationToken)
      .then(async (pageId) => {
        if (!pageId || cancelled || !tokens.isCurrent(operationToken)) {
          return
        }
        const pageToken = { ...operationToken, remotePageId: pageId }
        const tab = await this.session.fetchTabInfo(pageToken)
        if (tab && !cancelled && tokens.isCurrent(pageToken)) {
          deps.applyTabInfo(tab)
        }
        if (cancelled || !tokens.isCurrent(pageToken)) {
          return
        }
        const subscription = await this.startStream(pageId)
        if (cancelled || !subscription) {
          subscription?.unsubscribe()
          return
        }
        this.adoptSubscription(subscription)
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        if (isRemoteBrowserPageMissingError(error)) {
          deps.closeMissingRemotePage(tokens.remotePage)
          return
        }
        const failure = resolveRemoteBrowserStreamFailure(error, 'opening')
        if (failure.logRawError) {
          console.warn('[browser-pane] remote browser failed to open:', error)
        }
        // The host can close before subscribe rejects; preserve the newer armed restart’s ownership of status.
        if (this.restartScheduler.isScheduled) {
          return
        }
        // An initial open has no retry budget; preserve manual recovery.
        this.setStatus(remoteBrowserStreamStopped(failure.message))
      })
    return () => {
      cancelled = true
      this.retireInFlightWork()?.unsubscribe()
    }
  }

  // Frames are validated against the subscription’s starting viewport, so resizing needs a fresh stream.
  restartForViewport(pageId: string): boolean {
    const current = this.subscription
    const nextViewportSize = this.deps.readViewportSize()
    if (
      !current ||
      current.token.remotePageId !== pageId ||
      !nextViewportSize ||
      areRemoteViewportSizesNear(this.streamViewportSize, nextViewportSize) ||
      !this.tokens.isCurrentStreamToken(current.token)
    ) {
      return false
    }
    // Cancelling timers cannot recall dispatched retries; supersede their operation tokens before starting the replacement.
    this.retireInFlightWork()
    this.streamViewportSize = null
    // Guard resize completion against a newer operation owning the pane.
    const restartToken = this.tokens.createOperationToken(pageId)
    this.setStatus(REMOTE_BROWSER_STREAM_OPENING)
    current.unsubscribe()
    void this.startStream(pageId)
      .then((subscription) => {
        // A null stream means supersession; only its replacement may write status.
        if (!subscription) {
          return
        }
        this.adoptSubscription(subscription)
      })
      .catch((error: unknown) => {
        if (!restartToken || !this.tokens.isCurrent(restartToken)) {
          return
        }
        if (isRemoteBrowserPageMissingError(error)) {
          this.deps.closeMissingRemotePage(pageId)
          return
        }
        // Same race as open()'s catch: a close can arm a restart while this rejection is in flight.
        if (this.restartScheduler.isScheduled) {
          return
        }
        // Why classified: raw transport text (e.g. "pairing changed") is for logs, not the pane.
        const failure = resolveRemoteBrowserStreamFailure(error)
        if (failure.logRawError) {
          console.warn('[browser-pane] remote stream resize failed:', error)
        }
        // A resize during a blip tears down a live subscription and never reaches the budget.
        this.setStatus(remoteBrowserStreamStopped(failure.message))
      })
    return true
  }

  abandonRemotePage(): void {
    this.tokens.setRemotePage(null)
    this.retireInFlightWork()?.unsubscribe()
    this.session.cancelTabInfoRefresh()
  }

  // Unmount: retire in-flight work without unsubscribing, which the stream effect's own teardown owns.
  dispose(): void {
    this.tokens.supersedeOperations()
    this.tokens.supersedeStream()
    this.tokens.releaseStreamToken()
    this.streamViewportSize = null
    this.liveness.clear()
    this.restartScheduler.cancel()
    this.session.cancelTabInfoRefresh()
  }

  // Retire pending work and return the displaced subscription for caller-owned teardown.
  private retireInFlightWork(): RemoteBrowserStreamSubscription | null {
    this.tokens.supersedeOperations()
    this.tokens.supersedeStream()
    this.tokens.releaseStreamToken()
    this.liveness.clear()
    const previous = this.subscription
    this.subscription = null
    this.restartScheduler.cancel()
    return previous
  }

  private adoptSubscription(subscription: RemoteBrowserStreamSubscription): void {
    if (!this.tokens.isCurrentStreamToken(subscription.token)) {
      subscription.unsubscribe()
      return
    }
    this.subscription = subscription
    // A resize during open had no subscription to restart; apply the missed size now.
    this.restartForViewport(subscription.token.remotePageId)
  }

  private async startStream(pageId: string): Promise<RemoteBrowserStreamSubscription | null> {
    const { tokens, deps } = this
    const operationToken = tokens.createOperationToken(pageId)
    if (!operationToken || !tokens.isCurrent(operationToken)) {
      return null
    }
    const target: RuntimeClientTarget = {
      kind: 'environment',
      environmentId: operationToken.environmentId
    }
    const status = await deps.callRpc<RuntimeStatus>(target, 'status.get', undefined, {
      timeoutMs: 15_000
    })
    if (!status.capabilities?.includes('browser.screencast.v1')) {
      throw remoteBrowserStreamUnsupportedError()
    }
    if (!tokens.isCurrent(operationToken)) {
      return null
    }
    const viewportSize = await deps.waitForViewportSize()
    // Viewport measurement can await frames; recheck ownership before claiming the stream token or cancelling its ready deadline.
    if (!tokens.isCurrent(operationToken)) {
      return null
    }
    this.streamViewportSize = viewportSize
    const token = tokens.claimStreamToken(operationToken, pageId)
    // Treat a silent host as a drop so it spends the same bounded retry budget.
    this.liveness.watch(() => {
      if (this.tokens.isCurrentStreamToken(token)) {
        this.handleStreamClosed(token, true)
      }
    })
    try {
      const subscription = await openRemoteBrowserScreencastStream(
        deps.subscribeScreencast,
        {
          environmentId: target.environmentId,
          worktree: deps.getWorktreeSelector(),
          pageId,
          viewportSize,
          deviceScaleFactor: deps.getDeviceScaleFactor()
        },
        {
          isCurrent: () => tokens.isCurrentStreamToken(token),
          onReady: (event) => {
            // Record uptime; only sustained streams earn a refill at close. Live status also clears healed notices.
            this.liveness.markReady()
            this.setStatus(REMOTE_BROWSER_STREAM_LIVE)
            deps.applyTabInfo(event.tab)
            void deps.syncViewport(event.browserPageId).catch(() => {})
          },
          onEnded: () => this.handleStreamClosed(token, true),
          // A non-restarting host failure needs its specific message and manual recovery.
          onFailed: (message) => {
            this.setStatus(remoteBrowserStreamStopped(message))
            this.handleStreamClosed(token, false)
          },
          // onError may have no close: stop and cancel the ready deadline, but retain uptime so a later close can refill the budget.
          onTransportError: () => {
            this.liveness.stopWaitingForReady()
            this.setStatus(remoteBrowserStreamStopped(remoteBrowserStreamLostNotice()))
          },
          onPageMissing: () => deps.closeMissingRemotePage(pageId),
          onFrame: (bytes) => deps.handleFrameBytes(token, bytes),
          onClosed: () => this.handleStreamClosed(token, true)
        }
      )
      return { token, unsubscribe: subscription.unsubscribe }
    } catch (error) {
      if (tokens.isCurrentStreamToken(token)) {
        this.liveness.clear()
        tokens.releaseStreamToken()
      }
      throw error
    }
  }

  private handleStreamClosed(token: RemoteBrowserStreamToken, restart: boolean): void {
    if (!this.tokens.isCurrentStreamToken(token)) {
      return
    }
    // Only a stream that proved itself refills the budget; see REMOTE_BROWSER_STREAM_HEALTHY_MS.
    const wasHealthy = this.liveness.settle()
    if (restart && wasHealthy) {
      this.restartScheduler.reset()
    }
    // Keep blips silent until an attempt fails; non-restarting close preserves the caller’s notice.
    if (restart) {
      this.setStatus(remoteBrowserStreamRetrying(null))
    }
    const current = this.subscription
    this.subscription = null
    this.tokens.releaseStreamToken()
    this.streamViewportSize = null
    // Keep the last frame during navigation restarts to avoid flashing the loading placeholder.
    if (!restart) {
      this.deps.clearFrame()
    }
    current?.unsubscribe()
    if (restart) {
      this.scheduleStreamRestart(token)
    }
  }

  private scheduleStreamRestart(token: RemoteBrowserStreamToken): void {
    if (!this.tokens.isCurrentStreamOperation(token)) {
      return
    }
    this.restartScheduler.schedule(
      createRemoteBrowserStreamRestartAttempt(token, {
        tokens: this.tokens,
        session: this.session,
        setStatus: (status) => this.setStatus(status),
        applyTabInfo: (tab) => this.deps.applyTabInfo(tab),
        closeMissingRemotePage: (remotePageId) => this.deps.closeMissingRemotePage(remotePageId),
        startStream: (pageId) => this.startStream(pageId),
        adoptSubscription: (subscription) => this.adoptSubscription(subscription)
      })
    )
  }
}
