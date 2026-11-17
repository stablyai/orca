import type { RemoteRuntimeMultiplexedTerminalState } from '../streams/remote-terminal-stream-state'

export function clearSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
  stream.snapshotChunks = []
  stream.snapshotBytes = 0
  stream.snapshotOverflowed = false
  stream.snapshotTarget = 'initial'
  stream.snapshotInfo = null
}

export function clearPendingSnapshotRequest(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const request = stream.pendingSnapshotRequest
  stream.pendingSnapshotRequest = null
  if (request) {
    clearTimeout(request.timer)
  }
}

export function clearResyncTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const timer = stream.resyncTimer
  stream.resyncTimer = null
  if (timer) {
    clearTimeout(timer)
  }
}

export function rejectPendingSnapshotRequest(
  stream: RemoteRuntimeMultiplexedTerminalState,
  message: string
): void {
  const request = stream.pendingSnapshotRequest
  if (!request) {
    return
  }
  clearPendingSnapshotRequest(stream)
  request.reject(new Error(message))
}
