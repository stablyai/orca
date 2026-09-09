import {
  TerminalStreamOpcode,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR } from '../../../shared/terminal-multiplex-flow-control'
import { recordE2eRemoteTerminalInitialSnapshotTruncated } from './remote-runtime-terminal-e2e-control'
import { RemoteRuntimeTerminalResponseController } from './remote-runtime-terminal-response-controller'
import {
  MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  classifySnapshotAvailability,
  clearPendingSnapshotRequest,
  clearResyncTimer,
  clearSnapshot,
  concatBytes,
  decodeSnapshotInfo
} from './remote-runtime-terminal-snapshot-state'
import type { RemoteRuntimeMultiplexedTerminalState } from './remote-runtime-terminal-multiplexer-types'

export abstract class RemoteRuntimeTerminalBinarySnapshots extends RemoteRuntimeTerminalResponseController {
  protected handleSnapshotOrErrorFrame(
    frame: TerminalStreamFrame,
    stream: RemoteRuntimeMultiplexedTerminalState
  ): void {
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      clearSnapshot(stream)
      stream.snapshotInfo = decodeSnapshotInfo(frame.payload)
      const requestId = stream.snapshotInfo?.requestId
      stream.snapshotTarget =
        typeof requestId === 'number' ||
        (stream.initialSnapshotReceived && stream.pendingSnapshotRequest)
          ? 'request'
          : stream.initialSnapshotReceived
            ? 'recovery'
            : 'initial'
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
      if (stream.snapshotOverflowed) {
        return
      }
      stream.snapshotBytes += frame.payload.byteLength
      if (stream.snapshotBytes > MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES) {
        stream.snapshotOverflowed = true
        if (stream.snapshotTarget === 'initial') {
          stream.callbacks.onError?.(REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE)
        }
        return
      }
      stream.snapshotChunks.push(frame.payload)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
      const data = stream.snapshotOverflowed
        ? null
        : decodeTerminalStreamText(concatBytes(stream.snapshotChunks))
      const target = stream.snapshotTarget
      const info = stream.snapshotInfo
      const pendingRequest = stream.pendingSnapshotRequest
      if (target === 'initial' && info?.truncated === true) {
        recordE2eRemoteTerminalInitialSnapshotTruncated()
      }
      // Initial truncation drops retained history, but the latest-screen image remains authoritative.
      const snapshotApplied =
        !stream.snapshotOverflowed && (target === 'initial' || info?.truncated !== true)
      const matchesPendingRequest =
        target === 'request' &&
        pendingRequest &&
        (typeof info?.requestId === 'number'
          ? info.requestId === pendingRequest.requestId
          : stream.initialSnapshotReceived)
      if (snapshotApplied) {
        if (matchesPendingRequest) {
          pendingRequest.resolve({
            availability: classifySnapshotAvailability(stream.snapshotOverflowed, info),
            snapshot: {
              data: data ?? '',
              cols: info?.cols ?? 80,
              rows: info?.rows ?? 24,
              seq: info?.seq,
              source: info?.source,
              kittyKeyboardFlags: info?.kittyKeyboardFlags,
              alternateScreen: info?.alternateScreen,
              terminalOwner: info?.terminalOwner,
              pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
            }
          })
          clearPendingSnapshotRequest(stream)
        } else if (target === 'initial') {
          stream.callbacks.onSnapshot(data ?? '', {
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi,
            seq: info?.seq,
            kittyKeyboardFlags: info?.kittyKeyboardFlags,
            alternateScreen: info?.alternateScreen,
            terminalOwner: info?.terminalOwner,
            // Why: the image encodes wraps and cursor moves against the host's
            // grid, so the restorer must replay it there — the request path has
            // always carried these; the pushes silently dropped them.
            cols: info?.cols,
            rows: info?.rows
          })
        } else if (target === 'recovery') {
          // Why: a server-pushed recovery snapshot replaces terminal state
          // mid-session; clear the screen and scrollback before applying it.
          // An empty snapshot is still applied so stale dropped output does
          // not linger on a terminal the model says is blank.
          stream.callbacks.onSnapshot(`\x1b[2J\x1b[3J\x1b[H${data ?? ''}`, {
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi,
            seq: info?.seq,
            kittyKeyboardFlags: info?.kittyKeyboardFlags,
            alternateScreen: info?.alternateScreen,
            terminalOwner: info?.terminalOwner,
            cols: info?.cols,
            rows: info?.rows
          })
        }
      } else if (matchesPendingRequest) {
        pendingRequest.resolve({
          availability: classifySnapshotAvailability(stream.snapshotOverflowed, info),
          snapshot: null
        })
        clearPendingSnapshotRequest(stream)
      }
      clearSnapshot(stream)
      if (target === 'initial') {
        clearResyncTimer(stream)
        stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
        stream.commandProbeBaselineSeq = undefined
        stream.resyncInFlight = false
        stream.resyncPendingSend = false
        stream.initialSnapshotReceived = true
        stream.callbacks.onSubscribed?.()
      } else if (target === 'recovery') {
        // Why: only an applied recovery is authoritative; retaining the prior
        // high-water after a discarded snapshot keeps the gap detectable.
        if (snapshotApplied) {
          clearResyncTimer(stream)
          stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.commandProbeBaselineSeq = undefined
          stream.recoverySnapshotSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.resyncAttempts = 0
          stream.resyncInFlight = false
          stream.resyncPendingSend = false
        } else if (stream.resyncInFlight) {
          this.scheduleResyncRetry(stream)
        } else {
          // Why: a discarded server-pushed recovery leaves dropped output
          // unrepresented; pull a fresh snapshot now instead of waiting for
          // the next chunk to expose the gap.
          this.requestResyncSnapshot(stream)
        }
      } else {
        this.sendDeferredResyncSnapshot(stream)
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      const message = decodeTerminalStreamText(frame.payload)
      if (message === TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR) {
        stream.capacityRejected = true
        return
      }
      clearSnapshot(stream)
      const pendingSnapshotRequest = stream.pendingSnapshotRequest
      if (pendingSnapshotRequest) {
        clearPendingSnapshotRequest(stream)
        pendingSnapshotRequest.reject(new Error(message))
        this.sendDeferredResyncSnapshot(stream)
        return
      }
      // Why: a failed resync must re-open the live path or output stalls forever.
      clearResyncTimer(stream)
      stream.resyncInFlight = false
      stream.resyncPendingSend = false
      stream.callbacks.onError?.(message)
    }
  }
}
