import { splitRemoteBranchName } from './git-effective-upstream'
import type { GitHistoryItemRef } from './git-history-types'

// Drops a remote-tracking ref (e.g. origin/feature) when the matching local
// branch (feature) sits on the same commit. The two pills are redundant while
// local and remote point at the same commit; when they diverge they land on
// different commits and both still show.
export function dedupeRemoteTrackingRefs(refs: readonly GitHistoryItemRef[]): GitHistoryItemRef[] {
  const localBranchNames = new Set(
    refs.filter((ref) => ref.category === 'branches').map((ref) => ref.name)
  )
  if (localBranchNames.size === 0) {
    return [...refs]
  }
  return refs.filter((ref) => {
    if (ref.category !== 'remote branches') {
      return true
    }
    const split = splitRemoteBranchName(ref.name)
    return !split || !localBranchNames.has(split.branchName)
  })
}
