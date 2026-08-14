import type { NestedRepoCandidate } from './project-group-types'

/**
 * A submodule is a candidate you may opt into, not one that justifies asking.
 * The enclosing repo already owns its checked-out commit, so a plain repo that
 * merely has submodules must keep adding directly instead of being diverted into
 * a review it has nothing to review.
 */
export function isImportableNestedRepoCandidate(candidate: NestedRepoCandidate): boolean {
  return candidate.isSubmodule !== true
}

/** True when the scan found something worth opening the import review for. */
export function hasImportableNestedRepo(
  candidates: readonly NestedRepoCandidate[],
  selectedPath?: string
): boolean {
  return candidates.some(
    (candidate) =>
      isImportableNestedRepoCandidate(candidate) &&
      // The selected folder itself is never the discovery that justifies asking.
      candidate.path !== selectedPath
  )
}
