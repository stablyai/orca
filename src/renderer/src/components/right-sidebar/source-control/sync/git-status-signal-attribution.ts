import type { GitStatusMetadataChangedEvent } from '../../../../../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'

const REFRESH_EVERY_OBSERVER = (): boolean => true

/** Builds one signal's recipient test; observers pass their path already normalized, or null. */
export function gitStatusSignalRecipientTest(
  signal: GitStatusMetadataChangedEvent,
  readKnownRepoWorktreePaths: (repoId: string) => readonly string[]
): (normalizedObserverPath: string | null) => boolean {
  const attributed = signal.worktreePaths
  // Unattributed signals from older main/SSH/global changes may affect any checkout.
  if (!attributed?.length) {
    return REFRESH_EVERY_OBSERVER
  }
  const attributedPaths = new Set(attributed.map(normalizeRuntimePathForComparison))
  const knownPaths = new Set(
    readKnownRepoWorktreePaths(signal.repoId).map(normalizeRuntimePathForComparison)
  )
  // Skip only known siblings; unknown spellings such as symlinked roots may still name this checkout.
  for (const path of attributedPaths) {
    if (!knownPaths.has(path)) {
      return REFRESH_EVERY_OBSERVER
    }
  }
  return (normalizedObserverPath) =>
    normalizedObserverPath === null || attributedPaths.has(normalizedObserverPath)
}
