import type { WorkspaceSessionState } from './workspace-session-state-types'

export type ClosedOpenFilePruneArgs = {
  worktreeId: string
  filePath: string
}

/**
 * A closed editor file must not survive in host partitions the workspace no longer runs on: a
 * superseded partition's stale `openFilesByWorktree` row (with any `dirtyDraftContent`) re-
 * materializes the tab at the next hydration, so a close that only clears the current partition
 * loses to the residue (#42761).
 */
export function pruneClosedOpenFileFromSlice(
  slice: WorkspaceSessionState,
  { worktreeId, filePath }: ClosedOpenFilePruneArgs
): WorkspaceSessionState | null {
  const rows = slice.openFilesByWorktree?.[worktreeId]
  if (!rows || !rows.some((row) => row.filePath === filePath)) {
    return null
  }
  const kept = rows.filter((row) => row.filePath !== filePath)
  const openFilesByWorktree = { ...slice.openFilesByWorktree }
  if (kept.length > 0) {
    openFilesByWorktree[worktreeId] = kept
  } else {
    delete openFilesByWorktree[worktreeId]
  }
  return { ...slice, openFilesByWorktree }
}
