import type { GitStatusMetadataChangedEvent } from '../../../../shared/worktree/types'
import { areRuntimePathsEqual } from '../../../../shared/worktree/ownership'

/** Whether a metadata signal can have changed the active checkout's status.
 *  Unattributed signals (older main, SSH, global changes) always can. */
export function isGitStatusSignalForWorktree(
  signal: GitStatusMetadataChangedEvent,
  activeWorktreePath: string | null,
  repoWorktreePaths: readonly string[]
): boolean {
  const attributed = signal.worktreePaths
  if (!attributed?.length || !activeWorktreePath) {
    return true
  }
  if (attributed.some((path) => areRuntimePathsEqual(path, activeWorktreePath))) {
    return true
  }
  // Why: skip only when every path is a known sibling — an unknown spelling
  // (e.g. a symlinked repo root) may still be the active checkout.
  return !attributed.every((path) =>
    repoWorktreePaths.some((known) => areRuntimePathsEqual(path, known))
  )
}
