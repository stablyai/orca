// Why: several independent code paths call `git.status`; if only some carried
// the merge base the branch line-total chip would blank out between polls. One
// registry keeps every path asking for the same thing.
// Only the visible worktree's SourceControl is mounted and its effect cleanup
// deletes on every change, so this holds ~1 entry and needs no eviction.
const branchLineTotalMergeBaseByWorktree = new Map<string, string>()

/** `null` deletes the entry — that absence is the visibility gate (no merge base ⇒ no host cost). */
export function setBranchLineTotalMergeBase(worktreeId: string, mergeBase: string | null): void {
  if (!mergeBase) {
    branchLineTotalMergeBaseByWorktree.delete(worktreeId)
    return
  }
  branchLineTotalMergeBaseByWorktree.set(worktreeId, mergeBase)
}

export function getBranchLineTotalMergeBase(worktreeId: string): string | undefined {
  return branchLineTotalMergeBaseByWorktree.get(worktreeId)
}

export function clearBranchLineTotalRequestGateForTests(): void {
  branchLineTotalMergeBaseByWorktree.clear()
}
