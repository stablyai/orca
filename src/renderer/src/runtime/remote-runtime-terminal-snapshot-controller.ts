import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS } from '../../../shared/terminal-multiplex-flow-control'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { RemoteRuntimeTerminalMultiplexerBase } from './remote-runtime-terminal-multiplexer-base'
import {
  REMOTE_TERMINAL_RESYNC_MAX_UNANSWERED_TIMEOUTS,
  REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS,
  REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS,
  REMOTE_TERMINAL_RESYNC_TIMEOUT_MS,
  REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS,
  clearPendingSnapshotRequest,
  clearResyncTimer,
  disposeRemoteTerminalStreamState,
  retryWorthySnapshotOutcome
} from './remote-runtime-terminal-snapshot-state'
import type {
  RemoteRuntimeMultiplexedTerminalState,
  RemoteRuntimeSnapshotImage,
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotRequestOptions
} from './remote-runtime-terminal-multiplexer-types'

export abstract class RemoteRuntimeTerminalSnapshotController extends RemoteRuntimeTerminalMultiplexerBase {
  // Compare known UTF-16 high-waters: startSeq beyond expectedSeq proves dropped output. First/unknown seq cannot prove a gap.
  protected detectOutputGap(
    stream: RemoteRuntimeMultiplexedTerminalState,
    seq: number | undefined,
    rawLength: number
  ): boolean {
    if (typeof seq !== 'number' || typeof stream.expectedSeq !== 'number') {
      return false
    }
    const startSeq = seq - rawLength
    return startSeq > stream.expectedSeq
  }

  // Untagged requests select full-reset recovery, healing gaps without a user-facing error.
  protected requestResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (stream.resyncInFlight) {
      return
    }
    stream.resyncInFlight = true
    if (stream.pendingSnapshotRequest) {
      // Snapshot groups share one lane; wait for manual response before recovery. Arm watchdog now so consumed-but-undispatched requests cannot wedge it.
      stream.resyncPendingSend = true
      this.startResyncTimer(stream)
      return
    }
    this.sendResyncSnapshot(stream)
  }

  protected sendDeferredResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (!stream.resyncInFlight || !stream.resyncPendingSend || stream.pendingSnapshotRequest) {
      return
    }
    this.sendResyncSnapshot(stream)
  }

  private sendResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    stream.resyncPendingSend = false
    this.startResyncTimer(stream)
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.SnapshotRequest,
      // Why history: the gap lost output, so a screen-only answer would leave the pane no history to show.
      encodeTerminalStreamJson({ scrollbackRows: TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS })
    )
    if (!sent) {
      // Transport is down; the reconnect path re-subscribes from scratch.
      clearResyncTimer(stream)
      stream.resyncInFlight = false
    }
  }

  // Keep recovery pending through backoff so it heals even after output stops.
  protected scheduleResyncRetry(stream: RemoteRuntimeMultiplexedTerminalState): void {
    stream.resyncAttempts += 1
    const delay = Math.min(
      REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS,
      REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS * 2 ** Math.min(stream.resyncAttempts - 1, 4)
    )
    clearResyncTimer(stream)
    const timer = setTimeout(() => {
      if (
        stream.resyncTimer !== timer ||
        this.streams.get(stream.streamId) !== stream ||
        !stream.resyncInFlight
      ) {
        return
      }
      stream.resyncTimer = null
      if (stream.pendingSnapshotRequest) {
        stream.resyncPendingSend = true
        this.startResyncTimer(stream)
        return
      }
      this.sendResyncSnapshot(stream)
    }, delay)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    stream.resyncTimer = timer
  }

  // Do not expire a recovery while it streams; slow large images would trigger duplicate requests/repaints.
  protected noteResyncSnapshotProgress(stream: RemoteRuntimeMultiplexedTerminalState): void {
    stream.resyncUnansweredTimeouts = 0
    if (stream.resyncInFlight && !stream.resyncPendingSend) {
      this.startResyncTimer(stream)
    }
  }

  private startResyncTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
    clearResyncTimer(stream)
    const timer = setTimeout(() => {
      if (
        stream.resyncTimer !== timer ||
        this.streams.get(stream.streamId) !== stream ||
        !stream.resyncInFlight
      ) {
        return
      }
      stream.resyncTimer = null
      stream.resyncUnansweredTimeouts += 1
      if (stream.resyncUnansweredTimeouts >= REMOTE_TERMINAL_RESYNC_MAX_UNANSWERED_TIMEOUTS) {
        // Why: pending recovery refuses the watchdog's probe, so escalate here instead.
        this.recoverStalledStream(stream)
        return
      }
      // Retry without reopening: reopening retains the old expectedSeq and makes each next frame retrip the gap (#18488).
      this.scheduleResyncRetry(stream)
    }, REMOTE_TERMINAL_RESYNC_TIMEOUT_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    stream.resyncTimer = timer
  }

  protected async requestSnapshot(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: RemoteRuntimeSnapshotRequestOptions
  ): Promise<RemoteRuntimeSnapshotImage | null> {
    const outcome = await this.requestSnapshotOutcome(stream, opts)
    // Why: the concurrent-request guard used to reject before the outcome existed; keep that contract for legacy callers.
    if (
      outcome.availability.kind === 'retry-worthy' &&
      outcome.availability.cause === 'request-already-in-flight'
    ) {
      throw new Error('Remote terminal snapshot already in flight.')
    }
    return outcome.snapshot
  }

  protected requestSnapshotOutcome(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: RemoteRuntimeSnapshotRequestOptions
  ): Promise<RemoteRuntimeSnapshotOutcome> {
    if (this.streams.get(stream.streamId) !== stream) {
      return Promise.resolve(retryWorthySnapshotOutcome('stream-detached'))
    }
    if (!this.ready || !this.subscription) {
      return Promise.resolve(retryWorthySnapshotOutcome('connection-not-ready'))
    }
    // Recovery occupies the untagged snapshot lane; callers retry after completion instead of racing it.
    if (stream.resyncInFlight) {
      return Promise.resolve(retryWorthySnapshotOutcome('resync-in-flight'))
    }
    if (stream.pendingSnapshotRequest) {
      return Promise.resolve(retryWorthySnapshotOutcome('request-already-in-flight'))
    }
    const requestId = this.allocateSnapshotRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (stream.pendingSnapshotRequest?.timer === timer) {
          clearPendingSnapshotRequest(stream)
          reject(new Error('Remote terminal snapshot timed out.'))
          this.recoverStalledStream(stream)
        }
      }, REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      stream.pendingSnapshotRequest = {
        requestId,
        resolve,
        reject,
        timer,
        ...(opts?.repaintsPane ? { repaintsPane: true } : {})
      }
      if (
        !this.sendFrame(
          stream.streamId,
          TerminalStreamOpcode.SnapshotRequest,
          encodeTerminalStreamJson({ requestId, scrollbackRows: opts?.scrollbackRows })
        )
      ) {
        clearPendingSnapshotRequest(stream)
        resolve(retryWorthySnapshotOutcome('request-frame-not-sent'))
      }
    })
  }

  protected probeCommandResponse(stream: RemoteRuntimeMultiplexedTerminalState): void {
    void this.requestSnapshot(stream).then(
      (snapshot) => {
        if (this.streams.get(stream.streamId) !== stream) {
          return
        }
        if (typeof snapshot?.seq === 'number' && typeof stream.expectedSeq !== 'number') {
          if (
            typeof stream.commandProbeBaselineSeq === 'number' &&
            snapshot.seq > stream.commandProbeBaselineSeq
          ) {
            recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_baseline_advanced', {
              baselineSeq: stream.commandProbeBaselineSeq,
              environmentId: this.environmentId,
              snapshotSeq: snapshot.seq,
              streamId: stream.streamId,
              terminal: stream.terminal
            })
            this.recoverStalledStream(stream)
            return
          }
          stream.commandProbeBaselineSeq ??= snapshot.seq
        } else if (
          typeof snapshot?.seq === 'number' &&
          typeof stream.expectedSeq === 'number' &&
          snapshot.seq > stream.expectedSeq
        ) {
          recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_detected_gap', {
            deliveredSeq: stream.expectedSeq,
            environmentId: this.environmentId,
            snapshotSeq: snapshot.seq,
            streamId: stream.streamId,
            terminal: stream.terminal
          })
          this.recoverStalledStream(stream)
          return
        }
        stream.watchdog.completeCommandResponseProbe()
        recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_succeeded', {
          deliveredSeq: stream.expectedSeq ?? null,
          environmentId: this.environmentId,
          probeBaselineSeq: stream.commandProbeBaselineSeq ?? null,
          snapshotSeq: snapshot?.seq ?? null,
          streamId: stream.streamId,
          terminal: stream.terminal
        })
      },
      () => {
        // Snapshot timeout owns recovery; an explicit host error already proves liveness.
        if (this.streams.get(stream.streamId) === stream) {
          stream.watchdog.completeCommandResponseProbe()
        }
      }
    )
  }

  protected recoverStalledStream(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (this.streams.get(stream.streamId) !== stream) {
      return
    }
    disposeRemoteTerminalStreamState(stream, 'Remote terminal stream stopped responding.')
    this.streams.delete(stream.streamId)
    this.sendFrame(stream.streamId, TerminalStreamOpcode.Unsubscribe)
    if (stream.callbacks.onTransportClose) {
      stream.callbacks.onTransportClose({ recoverable: true, stalled: true })
    } else {
      stream.callbacks.onError?.('Remote terminal stream stopped responding.')
    }
    this.closeIfIdle()
  }
}
