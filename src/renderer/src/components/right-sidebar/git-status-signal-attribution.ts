import type { GitStatusMetadataChangedEvent } from '../../../../shared/worktree/types'
import { areRuntimePathsEqual } from '../../../../shared/worktree/ownership'

/** Unattributed signals from older main/SSH/global changes may affect any checkout. */
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
  // Skip only known siblings; unknown spellings such as symlinked roots may still name this checkout.
  return !attributed.every((path) =>
    repoWorktreePaths.some((known) => areRuntimePathsEqual(path, known))
  )
}
