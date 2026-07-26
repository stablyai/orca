let snapshotApplyDepth = 0
let writeSuppressUntil = 0

const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1000

export function isRemoteWorkspaceSnapshotApplyInProgress(): boolean {
  return snapshotApplyDepth > 0 || Date.now() < writeSuppressUntil
}

export function beginRemoteWorkspaceSnapshotApply(): void {
  snapshotApplyDepth += 1
}

export function finishRemoteWorkspaceSnapshotApply(): void {
  writeSuppressUntil = Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
  snapshotApplyDepth = Math.max(0, snapshotApplyDepth - 1)
}

export function suppressRemoteWorkspaceSnapshotWrites(): void {
  writeSuppressUntil = Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
}
