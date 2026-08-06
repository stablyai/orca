import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { RemoteBrowserPageSession } from './remote-browser-page-session'
import { openRemoteBrowserScreencastStream } from './remote-browser-screencast-subscription'
import { RemoteBrowserStreamRestartScheduler } from './remote-browser-stream-restart-scheduler'
import { REMOTE_BROWSER_STREAM_UNREACHABLE_MESSAGE } from './remote-browser-stream-messages'
import {
  isPermanentRemoteBrowserStreamFailure,
  isRemoteBrowserPageMissingError,
  remoteBrowserStreamUnsupportedError,
  resolveRemoteBrowserStreamRestartFailure
} from './remote-browser-stream-errors'
import {
  areRemoteViewportSizesNear,
  RemoteBrowserOperationTokens,
  toOperationToken,
  type RemoteBrowserStreamSubscription,
  type RemoteBrowserStreamToken,
  type RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
export type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'

// Owns the remote browser screencast lifecycle for one pane: opening the stream, self-healing a
// dropped one with bounded backoff, restarting it after a viewport change, and tearing everything
// down. Kept out of React so each of those paths can be driven from a test with injected deps.
export class RemoteBrowserStreamLifecycle {
  readonly tokens: RemoteBrowserOperationTokens
  readonly session: RemoteBrowserPageSession
  private readonly restartScheduler: RemoteBrowserStreamRestartScheduler
  private subscription: RemoteBrowserStreamSubscription | null = null
  private streamViewportSize: RemoteBrowserViewportSize | null = null

  constructor(private readonly deps: RemoteBrowserStreamLifecycleDeps) {
    this.tokens = new RemoteBrowserOperationTokens(deps.identity)
    this.session = new RemoteBrowserPageSession({ ...deps, tokens: this.tokens })
    this.restartScheduler = new RemoteBrowserStreamRestartScheduler(undefined, () =>
      deps.setReconnectAvailable(true)
    )
  }

  get restartAttemptCount(): number {
    return this.restartScheduler.attemptCount
  }

  forgetStreamViewportSize(): void {
    this.streamViewportSize = null
  }

  // Opens the stream for the active pane and returns the teardown for that attempt.
  open(): () => void {
    let cancelled = false
    const { tokens, deps } = this
    deps.setBusy(true)
    deps.setError(null)
    // Why cleared here: a reopen (tab switch, environment or worktree change, or Reconnect) starts a
    // fresh budget, so a flag left over from a previous exhaustion would show the control while
    // attempts remain — the one state the pane must never present.
    deps.setReconnectAvailable(false)
    this.retireInFlightWork()?.unsubscribe()
    const operationToken = tokens.createOperationToken()
    if (!operationToken) {
      deps.setBusy(false)
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
        // Why classified here too: the same condition (a host that cannot stream) reaches both this
        // path and the restart path, and it must not read as "unreachable" here and as its own
        // specific message there.
        const permanent = isPermanentRemoteBrowserStreamFailure(error)
        if (!permanent) {
          console.warn('[browser-pane] remote browser failed to open:', error)
        }
        // "Unreachable" rather than "lost": nothing was ever established here. And this path never
        // had a stream, so the retry budget never runs — without the affordance below, nothing else
        // would ever offer a way back and the pane strands on a bare error.
        deps.setError(
          permanent && error instanceof Error
            ? error.message
            : REMOTE_BROWSER_STREAM_UNREACHABLE_MESSAGE()
        )
        deps.setReconnectAvailable(true)
        deps.setBusy(false)
      })
    return () => {
      cancelled = true
      this.retireInFlightWork()?.unsubscribe()
    }
  }

  // Why: the runtime stream validates frames against its start viewport, so a resize needs a fresh
  // subscription or the new-size frames get rejected.
  restartForViewport(pageId: string): void {
    const current = this.subscription
    const nextViewportSize = this.deps.readViewportSize()
    if (
      !current ||
      current.token.remotePageId !== pageId ||
      !nextViewportSize ||
      areRemoteViewportSizesNear(this.streamViewportSize, nextViewportSize) ||
      !this.tokens.isCurrentStreamToken(current.token)
    ) {
      return
    }
    // Why: cancel() cannot recall a retry already dispatched into an await. Bumping the operation
    // generation — as every other supersession site does — makes that attempt's own token guard
    // fail, so it cannot subscribe concurrently with the restart below.
    this.retireInFlightWork()
    this.streamViewportSize = null
    // Why: without a token the .then/.catch below would mutate busy/remoteError on behalf of a
    // restart that a newer operation has already replaced.
    const restartToken = this.tokens.createOperationToken(pageId)
    this.deps.setBusy(true)
    current.unsubscribe()
    void this.startStream(pageId)
      .then((subscription) => {
        if (!subscription) {
          if (restartToken && this.tokens.isCurrent(restartToken)) {
            this.deps.setBusy(false)
          }
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
        this.deps.setError(
          error instanceof Error ? error.message : 'Failed to resize remote browser stream.'
        )
        this.deps.setBusy(false)
      })
  }

  // Drops every handle this pane holds on a runtime page that is gone.
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
    this.restartScheduler.cancel()
    this.session.cancelTabInfoRefresh()
  }

  // Retires every in-flight guard token and the pending retry, and hands back the subscription the
  // caller is displacing so it can be released at the point the original code released it.
  private retireInFlightWork(): RemoteBrowserStreamSubscription | null {
    this.tokens.supersedeOperations()
    this.tokens.supersedeStream()
    this.tokens.releaseStreamToken()
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
    this.streamViewportSize = viewportSize
    const token = tokens.claimStreamToken(operationToken, pageId)
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
            // Why: a confirmed-live stream forgets prior restart failures and the failure they
            // reported, or a recovered pane keeps showing a toast it already healed (STA-3483).
            this.restartScheduler.reset()
            deps.setError(null)
            deps.setReconnectAvailable(false)
            deps.applyTabInfo(event.tab)
            void deps.syncViewport(event.browserPageId).catch(() => {})
            deps.setBusy(false)
          },
          onEnded: () => this.handleStreamClosed(token, true),
          onFailed: (message) => {
            deps.setError(message)
            this.handleStreamClosed(token, false)
          },
          onTransportError: (message) => {
            deps.setError(message)
            deps.setBusy(false)
          },
          onPageMissing: () => deps.closeMissingRemotePage(pageId),
          onFrame: (bytes) => deps.handleFrameBytes(token, bytes),
          onClosed: () => this.handleStreamClosed(token, true)
        }
      )
      return { token, unsubscribe: subscription.unsubscribe }
    } catch (error) {
      if (tokens.isCurrentStreamToken(token)) {
        tokens.releaseStreamToken()
      }
      throw error
    }
  }

  private handleStreamClosed(token: RemoteBrowserStreamToken, restart: boolean): void {
    if (!this.tokens.isCurrentStreamToken(token)) {
      return
    }
    this.deps.setBusy(restart)
    const current = this.subscription
    this.subscription = null
    this.tokens.releaseStreamToken()
    this.streamViewportSize = null
    // Why: navigation recreates the screencast stream; keep the last frame during restart so panes
    // don't flash the loading placeholder.
    if (!restart) {
      this.deps.clearFrame()
    }
    current?.unsubscribe()
    if (restart) {
      this.scheduleStreamRestart(token)
    }
  }

  private scheduleStreamRestart(token: RemoteBrowserStreamToken): void {
    const { tokens, deps } = this
    if (!tokens.isCurrentStreamOperation(token) || this.restartScheduler.isScheduled) {
      return
    }
    // Why: a failed self-heal attempt must keep retrying with bounded backoff (STA-3483) instead of
    // leaving the pane holding a dead subscription with no way back.
    this.restartScheduler.schedule(async (): Promise<boolean> => {
      if (!tokens.isCurrentStreamOperation(token)) {
        return false
      }
      deps.setBusy(true)
      const operationToken = toOperationToken(token)
      try {
        const tab = await this.session.fetchTabInfo(operationToken).catch(() => null)
        if (tab && tokens.isCurrentStreamOperation(token)) {
          deps.applyTabInfo(tab)
        }
        if (!tokens.isCurrentStreamOperation(token)) {
          return false
        }
        const subscription = await this.startStream(token.remotePageId)
        if (subscription) {
          this.adoptSubscription(subscription)
        }
        return false
      } catch (error) {
        if (!tokens.isCurrentStreamOperation(token)) {
          return false
        }
        if (isRemoteBrowserPageMissingError(error)) {
          deps.closeMissingRemotePage(token.remotePageId)
          return false
        }
        const failure = resolveRemoteBrowserStreamRestartFailure(error)
        if (failure.logRawError) {
          // The raw text is transport-level and written for logs; keep it out of the UI but not
          // out of reach, since nothing else records it.
          console.warn('[browser-pane] remote stream restart failed:', error)
        }
        deps.setError(failure.message)
        // Why also when we stop: giving up on automatic retries is not the same as taking away the
        // user's last resort. A classification we got wrong would otherwise strand the pane exactly
        // as it did before this work.
        if (!failure.shouldRetry) {
          deps.setReconnectAvailable(true)
        }
        deps.setBusy(false)
        return failure.shouldRetry
      }
    })
  }
}
