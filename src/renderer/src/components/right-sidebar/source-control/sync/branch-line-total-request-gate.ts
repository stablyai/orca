// Share merge-base requests across status callers so totals do not blink; mounted-panel cleanup bounds this map to ~1 entry.
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
