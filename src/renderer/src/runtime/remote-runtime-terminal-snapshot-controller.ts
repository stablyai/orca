import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { RemoteRuntimeTerminalMultiplexerBase } from './remote-runtime-terminal-multiplexer-base'
import {
  REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS,
  REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS,
  REMOTE_TERMINAL_RESYNC_TIMEOUT_MS,
  REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS,
  clearPendingSnapshotRequest,
  clearResyncTimer,
  clearSnapshot,
  discardOutputAcknowledgements,
  rejectPendingSnapshotRequest,
  retryWorthySnapshotOutcome
} from './remote-runtime-terminal-snapshot-state'
import type {
  RemoteRuntimeMultiplexedTerminalState,
  RemoteRuntimeSnapshotOutcome
} from './remote-runtime-terminal-multiplexer-types'

export abstract class RemoteRuntimeTerminalSnapshotController extends RemoteRuntimeTerminalMultiplexerBase {
  // Why: Output `seq` is the UTF-16 high-water at the end of a chunk, so a chunk
  // that begins after the last high-water (startSeq > expectedSeq) means the
  // server dropped intervening frames under backpressure. Only flag a gap when
  // both offsets are known, and never on the first seq (nothing to compare to).
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

  // Why: on a detected gap, discard the corrupt tail and pull a fresh
  // authoritative snapshot. The request carries no requestId so the server
  // reply renders through the initial-snapshot path (full reset), self-healing
  // without surfacing an error to the user.
  protected requestResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (stream.resyncInFlight) {
      return
    }
    stream.resyncInFlight = true
    if (stream.pendingSnapshotRequest) {
      // Why: snapshot frame groups are not multiplexed; wait for the manual
      // snapshot to finish so its response cannot be mistaken for recovery.
      // Arm the watchdog now so a dispatch path that consumes the pending
      // request without re-dispatching cannot hold the gate shut forever.
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
      encodeTerminalStreamJson({ scrollbackRows: undefined })
    )
    if (!sent) {
      // Transport is down; the reconnect path re-subscribes from scratch.
      clearResyncTimer(stream)
      stream.resyncInFlight = false
    }
  }

  // Why: keep the gate shut across the backoff — the post-gap tail is corrupt
  // either way — and heal even if the flood ends with no further output.
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
      stream.resyncInFlight = false
      stream.resyncPendingSend = false
    }, REMOTE_TERMINAL_RESYNC_TIMEOUT_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    stream.resyncTimer = timer
  }

  protected async requestSnapshot(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null> {
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
    opts?: { scrollbackRows?: number }
  ): Promise<RemoteRuntimeSnapshotOutcome> {
    if (this.streams.get(stream.streamId) !== stream) {
      return Promise.resolve(retryWorthySnapshotOutcome('stream-detached'))
    }
    if (!this.ready || !this.subscription) {
      return Promise.resolve(retryWorthySnapshotOutcome('connection-not-ready'))
    }
    // Recovery uses an untagged snapshot frame group; callers can retry after
    // it completes instead of racing another request onto the same frame lane.
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
      stream.pendingSnapshotRequest = { requestId, resolve, reject, timer }
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
    stream.watchdog.dispose()
    discardOutputAcknowledgements(stream)
    clearSnapshot(stream)
    clearResyncTimer(stream)
    rejectPendingSnapshotRequest(stream, 'Remote terminal stream stopped responding.')
    this.streams.delete(stream.streamId)
    this.sendFrame(stream.streamId, TerminalStreamOpcode.Unsubscribe)
    if (stream.callbacks.onTransportClose) {
      stream.callbacks.onTransportClose({ recoverable: true })
    } else {
      stream.callbacks.onError?.('Remote terminal stream stopped responding.')
    }
    this.closeIfIdle()
  }
}
