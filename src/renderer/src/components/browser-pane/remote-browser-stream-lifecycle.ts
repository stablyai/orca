import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
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
  remoteBrowserStreamUnreachableNotice,
  REMOTE_BROWSER_STREAM_IDLE
} from './remote-browser-stream-status'
import {
  isPermanentRemoteBrowserStreamFailure,
  isRemoteBrowserPageMissingError,
  remoteBrowserStreamUnsupportedError,
  resolveRemoteBrowserStreamRestartFailure
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

// Owns the remote browser screencast lifecycle for one pane: opening the stream, self-healing a
// dropped one with bounded backoff, restarting it after a viewport change, and tearing everything
// down. Kept out of React so each of those paths can be driven from a test with injected deps.
export class RemoteBrowserStreamLifecycle {
  readonly tokens: RemoteBrowserOperationTokens
  readonly session: RemoteBrowserPageSession
  private readonly restartScheduler: RemoteBrowserStreamRestartScheduler
  private subscription: RemoteBrowserStreamSubscription | null = null
  private streamViewportSize: RemoteBrowserViewportSize | null = null
  private readonly liveness = new RemoteBrowserStreamLiveness()

  constructor(private readonly deps: RemoteBrowserStreamLifecycleDeps) {
    this.tokens = new RemoteBrowserOperationTokens(deps.identity)
    this.session = new RemoteBrowserPageSession({ ...deps, tokens: this.tokens })
    // Why exhaustion publishes a message too: a budget can drain without any attempt throwing —
    // each restart subscribes fine, then the stream ends before 'ready', so the catch that normally
    // reports never runs. 'stopped' carries its notice, so that case cannot go silent.
    this.restartScheduler = new RemoteBrowserStreamRestartScheduler(undefined, () =>
      deps.setStatus(remoteBrowserStreamStopped(remoteBrowserStreamLostNotice()))
    )
  }

  forgetStreamViewportSize(): void {
    this.streamViewportSize = null
  }

  // Opens the stream for the active pane and returns the teardown for that attempt.
  open(): () => void {
    let cancelled = false
    const { tokens, deps } = this
    // A reopen (tab switch, environment or worktree change, or Reconnect) starts a fresh budget, so
    // 'opening' replaces whatever the previous attempt ended on — including a spent 'stopped'.
    deps.setStatus(REMOTE_BROWSER_STREAM_OPENING)
    this.retireInFlightWork()?.unsubscribe()
    const operationToken = tokens.createOperationToken()
    if (!operationToken) {
      deps.setStatus(REMOTE_BROWSER_STREAM_IDLE)
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
        // Why this can be the loser of a race: the stream token is claimed before subscribe is
        // awaited, so a close can arrive and arm a restart while this promise is still rejecting —
        // the host closes the subscription and only then throws (src/main/ipc/runtime-environments.ts
        // 'pairing changed'). Publishing 'stopped' over an armed restart shows a manual control for
        // one backoff step and then swaps it for a spinner. The armed restart is the newer owner.
        if (this.restartScheduler.isScheduled) {
          return
        }
        // "Unreachable" rather than "lost": nothing was ever established here. And this path never
        // had a stream, so the retry budget never runs — 'stopped' is what hands the user a way back.
        deps.setStatus(
          remoteBrowserStreamStopped(
            permanent && error instanceof Error
              ? error.message
              : remoteBrowserStreamUnreachableNotice()
          )
        )
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
    this.deps.setStatus(REMOTE_BROWSER_STREAM_OPENING)
    current.unsubscribe()
    void this.startStream(pageId)
      .then((subscription) => {
        // Why no status write: startStream returns null only when this very token was superseded,
        // so a newer operation already owns the status and writing here would clobber it.
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
        // Why classified rather than forwarded: this was the one failure path still putting raw
        // transport text in the UI ("Runtime environment pairing changed; refresh and try again"),
        // which is written for logs and names our internals. The other two paths already classify.
        const failure = resolveRemoteBrowserStreamRestartFailure(error)
        if (failure.logRawError) {
          console.warn('[browser-pane] remote stream resize failed:', error)
        }
        // A resize during a blip tears down a live subscription and never reaches the budget.
        this.deps.setStatus(remoteBrowserStreamStopped(failure.message))
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
    this.liveness.clear()
    this.restartScheduler.cancel()
    this.session.cancelTabInfoRefresh()
  }

  // Retires every in-flight guard token and the pending retry, and hands back the subscription the
  // caller is displacing so it can be released at the point the original code released it.
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
    // Why this guard, which every other await here already had: waitForViewportSize can block for a
    // few frames while the element is unmeasurable, and a superseded attempt resuming after that
    // would claim the stream token out from under the live stream — and, since one deadline is kept
    // per pane, cancel its safety net too. The pane then sits in 'opening' with nothing pending.
    if (!tokens.isCurrent(operationToken)) {
      return null
    }
    this.streamViewportSize = viewportSize
    const token = tokens.claimStreamToken(operationToken, pageId)
    // Treated as a drop rather than announced directly, so a hung host spends the same budget and
    // ends at the same 'stopped' with a reconnect as a host that refuses outright.
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
            // Why a timestamp and not restartScheduler.reset(): the budget is refilled at close
            // time, and only by a stream that lasted — see REMOTE_BROWSER_STREAM_HEALTHY_MS.
            // 'live' carries no notice, so a toast the retry already healed cannot survive
            // (STA-3483).
            this.liveness.markReady()
            deps.setStatus(REMOTE_BROWSER_STREAM_LIVE)
            deps.applyTabInfo(event.tab)
            void deps.syncViewport(event.browserPageId).catch(() => {})
          },
          onEnded: () => this.handleStreamClosed(token, true),
          // Why onFailed announces a stop: the runtime reported the stream itself failed, and the
          // close below is deliberately non-restarting, so nothing else would hand the user a way
          // back. Its message is the host's own, which is more specific than any substitute.
          onFailed: (message) => {
            deps.setStatus(remoteBrowserStreamStopped(message))
            this.handleStreamClosed(token, false)
          },
          // Why 'stopped' and not 'retrying': a transport error is NOT guaranteed to be followed by
          // a close. The web client's notifySubscriptionsError clears its subscription map and then
          // delivers onError only, so on that path no close ever arrives — and 'retrying' would
          // leave the pane busy forever with no way back, worse than the bug this PR fixes. When a
          // close does follow (the usual case) it publishes 'retrying', which replaces this within
          // the same tick. Landing in the actionable state and being corrected is safe; the reverse
          // is not.
          // Why the deadline is cancelled here: this is the one stream-ending path that keeps its
          // token, so the 'never said ready' deadline stays armed and its guard still passes. It
          // would then fire against a stream already declared stopped and republish 'retrying' —
          // withdrawing the reconnect control 30s after handing it over, with no user action, and
          // reopening the strand this whole feature exists to remove. Not clear(): a close that
          // does follow must still refill the budget for a stream that had been healthy.
          onTransportError: () => {
            this.liveness.stopWaitingForReady()
            deps.setStatus(remoteBrowserStreamStopped(remoteBrowserStreamLostNotice()))
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
    // Why no notice yet: the budget exists to absorb a blip invisibly, so nothing is said until an
    // attempt has actually failed. A non-restarting close leaves whatever the caller published.
    if (restart) {
      this.deps.setStatus(remoteBrowserStreamRetrying(null))
    }
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

  // Why: a failed self-heal attempt must keep retrying with bounded backoff (STA-3483) instead of
  // leaving the pane holding a dead subscription with no way back.
  private scheduleStreamRestart(token: RemoteBrowserStreamToken): void {
    if (!this.tokens.isCurrentStreamOperation(token)) {
      return
    }
    this.restartScheduler.schedule(
      createRemoteBrowserStreamRestartAttempt(token, {
        tokens: this.tokens,
        session: this.session,
        setStatus: (status) => this.deps.setStatus(status),
        applyTabInfo: (tab) => this.deps.applyTabInfo(tab),
        closeMissingRemotePage: (remotePageId) => this.deps.closeMissingRemotePage(remotePageId),
        startStream: (pageId) => this.startStream(pageId),
        adoptSubscription: (subscription) => this.adoptSubscription(subscription)
      })
    )
  }
}
