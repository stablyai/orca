import type { RemoteRuntimeMultiplexedTerminalState } from './remote-terminal-stream-state'
import {
  clearSnapshot,
  clearResyncTimer,
  rejectPendingSnapshotRequest
} from '../snapshots/remote-terminal-snapshot-lifecycle'

export function clearAckFlushTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  if (stream.ackFlushTimer !== null) {
    clearTimeout(stream.ackFlushTimer)
    stream.ackFlushTimer = null
  }
}

export function discardOutputAcknowledgements(stream: RemoteRuntimeMultiplexedTerminalState): void {
  clearAckFlushTimer(stream)
  stream.pendingAckBytes = 0
  stream.heldAckBytes = 0
}

export function disposeRemoteTerminalStreamState(
  stream: RemoteRuntimeMultiplexedTerminalState,
  message: string
): void {
  discardOutputAcknowledgements(stream)
  stream.watchdog.dispose()
  clearSnapshot(stream)
  clearResyncTimer(stream)
  rejectPendingSnapshotRequest(stream, message)
}
