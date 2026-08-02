import { splitRemoteBranchName } from './git-effective-upstream'
import type { GitHistoryItemRef } from './git-history-types'

type DedupeRemoteTrackingRefsOptions = {
  preserveRefIds?: ReadonlySet<string> | readonly string[]
}

// Drops a remote-tracking ref (e.g. origin/feature) when the matching local
// branch (feature) sits on the same commit. The two pills are redundant while
// local and remote point at the same commit; when they diverge they land on
// different commits and both still show.
export function dedupeRemoteTrackingRefs(
  refs: readonly GitHistoryItemRef[],
  options: DedupeRemoteTrackingRefsOptions = {}
): GitHistoryItemRef[] {
  const localBranchNames = new Set(
    refs.filter((ref) => ref.category === 'branches').map((ref) => ref.name)
  )
  if (localBranchNames.size === 0) {
    return [...refs]
  }
  const preserveRefIds = new Set(options.preserveRefIds ?? [])
  const matchingRemoteCounts = countUnambiguousMatchingRemoteBranches(refs, localBranchNames)
  return refs.filter((ref) => {
    if (ref.category !== 'remote branches') {
      return true
    }
    if (preserveRefIds.has(ref.id)) {
      return true
    }
    if (isAmbiguousRemoteTrackingRef(ref.name)) {
      return true
    }
    const split = splitRemoteBranchName(ref.name)
    if (!split || !localBranchNames.has(split.branchName)) {
      return true
    }
    // Why: without the repo's configured upstream remote, multiple matching
    // remotes (origin/main, upstream/main) are distinct context, not duplicates.
    return matchingRemoteCounts.get(split.branchName) !== 1
  })
}

function isAmbiguousRemoteTrackingRef(refName: string): boolean {
  // Why: without configured remote names, `foo/bar/main` could be remote
  // `foo` branch `bar/main` or remote `foo/bar` branch `main`.
  return refName.split('/').length > 2
}

function countUnambiguousMatchingRemoteBranches(
  refs: readonly GitHistoryItemRef[],
  localBranchNames: ReadonlySet<string>
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ref of refs) {
    if (ref.category !== 'remote branches' || isAmbiguousRemoteTrackingRef(ref.name)) {
      continue
    }
    const split = splitRemoteBranchName(ref.name)
    if (!split || !localBranchNames.has(split.branchName)) {
      continue
    }
    counts.set(split.branchName, (counts.get(split.branchName) ?? 0) + 1)
  }
  return counts
}
