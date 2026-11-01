import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../shared/terminal-mode-reset-profiles'
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
import type {
  RemoteRuntimeMultiplexedTerminalCallbacks,
  RemoteRuntimeMultiplexedTerminalState
} from './remote-runtime-terminal-multiplexer-types'

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
      if (stream.snapshotTarget === 'recovery') {
        this.noteResyncSnapshotProgress(stream)
      }
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
      if (stream.snapshotTarget === 'recovery') {
        this.noteResyncSnapshotProgress(stream)
      }
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
      // Why: a recovery the host marks unavailable carries '' that is not the buffer; applying it erases the pane.
      const snapshotApplied =
        target === 'recovery'
          ? classifySnapshotAvailability(stream.snapshotOverflowed, info).kind === 'snapshot'
          : !stream.snapshotOverflowed && (target === 'initial' || info?.truncated !== true)
      const matchesPendingRequest =
        target === 'request' &&
        pendingRequest &&
        (typeof info?.requestId === 'number'
          ? info.requestId === pendingRequest.requestId
          : stream.initialSnapshotReceived)
      if (snapshotApplied) {
        const pushedMeta: NonNullable<
          Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onSnapshot']>[1]
        > = {
          pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi,
          seq: info?.seq,
          kittyKeyboardFlags: info?.kittyKeyboardFlags,
          alternateScreen: info?.alternateScreen,
          terminalOwner: info?.terminalOwner,
          lastTitle: info?.lastTitle,
          // Replay at host grid dimensions because wraps/cursor moves depend on it; pushes must carry the same dimensions as requests.
          cols: info?.cols,
          rows: info?.rows,
          // Absent counts as none: older hosts push desktop images screen-only.
          carriesHistory: (info?.scrollbackRows ?? 0) > 0
        }
        if (matchesPendingRequest) {
          const availability = classifySnapshotAvailability(stream.snapshotOverflowed, info)
          if (
            pendingRequest.repaintsPane &&
            availability.kind === 'snapshot' &&
            typeof info?.seq === 'number'
          ) {
            // Why: the repaint covers the announced pause gap; a later loss must still resync.
            stream.pausedOutputGapExpected = false
            if (typeof stream.expectedSeq === 'number' && info.seq > stream.expectedSeq) {
              // Applied reveal image covers paused output through info.seq; stale baseline falsely resyncs and clears it (#22087).
              stream.expectedSeq = info.seq
            }
          }
          pendingRequest.resolve({
            availability,
            snapshot: {
              data: data ?? '',
              cols: info?.cols ?? 80,
              rows: info?.rows ?? 24,
              seq: info?.seq,
              source: info?.source,
              kittyKeyboardFlags: info?.kittyKeyboardFlags,
              alternateScreen: info?.alternateScreen,
              terminalOwner: info?.terminalOwner,
              lastTitle: info?.lastTitle,
              pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi,
              // The host folds the normal buffer into `data` (see terminal-snapshot-publication.ts).
              carriesNormalBuffer: true
            }
          })
          clearPendingSnapshotRequest(stream)
        } else if (target === 'initial') {
          stream.callbacks.onSnapshot(data ?? '', pushedMeta)
        } else if (target === 'recovery') {
          // Pushed recovery replaces screen/scrollback, including empty images, because dropped output leaves an unsafe splice gap (P2-5). RELEASE_SYNCHRONIZED_OUTPUT clears mode 2026: erase-screen alone leaves its latch blocking paint.
          stream.callbacks.onSnapshot(
            `${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H${data ?? ''}`,
            pushedMeta
          )
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
        // Only applied recovery advances authority; discarded images must leave the prior gap detectable.
        if (snapshotApplied) {
          clearResyncTimer(stream)
          stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.commandProbeBaselineSeq = undefined
          stream.recoverySnapshotSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.pausedOutputGapExpected = false
          stream.resyncAttempts = 0
          stream.resyncInFlight = false
          stream.resyncPendingSend = false
        } else if (stream.resyncInFlight) {
          this.scheduleResyncRetry(stream)
        } else {
          // Discarded pushed recovery leaves output missing; pull now instead of waiting for another chunk to expose it.
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
