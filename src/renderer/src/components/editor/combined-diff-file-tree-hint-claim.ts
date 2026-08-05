// Why module-level: the workspace diff, the PR page, and the PR item view can all be
// mounted at once (split panes multiply that further), and only one of them may open the
// one-shot callout. The persisted flag lands a render too late to arbitrate.
let claimedThisSession = false

/** Returns true only for the first caller in this session; every later caller loses. */
export function claimCombinedDiffFileTreeHint(): boolean {
  if (claimedThisSession) {
    return false
  }
  claimedThisSession = true
  return true
}

/** Test-only: module state outlives a single render tree. */
export function resetCombinedDiffFileTreeHintClaim(): void {
  claimedThisSession = false
}
